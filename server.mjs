import express from "express";
import axios from "axios";
import { JSDOM } from "jsdom";
import path from "path";
import { fileURLToPath } from "url";
import open from "open";
import fs from "fs";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);

/* ---------- Logs de segurança ---------- */
process.on("unhandledRejection", (err) =>
  console.error("unhandledRejection:", err)
);
process.on("uncaughtException", (err) =>
  console.error("uncaughtException:", err)
);

/* ---------- Headers tipo navegador ---------- */
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  Referer: "https://www.instagram.com/",
};

/* ---------- Static & health ---------- */
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.send("ok"));
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

/* ---------- Download genérico ---------- */
app.get("/download", async (req, res) => {
  try {
    const postUrl = req.query.url;
    if (!postUrl) return res.status(400).send("Faltou o parâmetro ?url=");

    if (isYoutubeUrl(postUrl)) {
      return res.redirect(
        302,
        `/download-youtube?url=${encodeURIComponent(postUrl)}`
      );
    }

    const normalized = normalizePostUrl(postUrl);
    const videoUrl = await findVideoUrl(normalized);

    if (!videoUrl) {
      return res
        .status(404)
        .send(
          "Não encontrei o vídeo (post privado, sem metatags ou layout mudou)."
        );
    }

    const filename = `${defaultFileName(normalized)}.mp4`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const r = await axios.get(videoUrl, {
      responseType: "stream",
      headers: HEADERS,
      timeout: 60000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    if (r.status >= 400)
      return res.status(r.status).send(`Falha ao baixar mídia (${r.status})`);
    r.data.pipe(res);
  } catch (err) {
    console.error("Erro /download:", err?.message || err);
    res.status(500).send(err?.message || "Erro ao baixar");
  }
});

/* ---------- Download YouTube ---------- */
app.get("/download-youtube", async (req, res) => {
  try {
    const ytUrl = req.query.url;
    if (!ytUrl)
      return res
        .status(400)
        .send("Use /download-youtube?url=<link do YouTube>");

    await cleanupYtdlDumps(__dirname);

    // Busca título real do vídeo
    const title = await getYoutubeTitle(ytUrl);
    const filename = sanitizeFilename(title || "youtube_video") + ".mp4";

    return downloadWithYtDlp(ytUrl, res, filename, {
      progressiveOnly: true,
    });
  } catch (err) {
    console.error("Erro /download-youtube:", err?.message || err);
    res.status(500).send(err?.message || "Erro ao processar vídeo do YouTube.");
  } finally {
    await cleanupYtdlDumps(__dirname);
  }
});

/* ---------- Debug Instagram ---------- */
app.get("/debug", async (req, res) => {
  try {
    const postUrl = req.query.url;
    if (!postUrl) return res.status(400).send("Use /debug?url=<link>");

    const normalized = normalizePostUrl(postUrl);
    const variants = [
      normalized,
      normalized + "embed/captioned/",
      normalized + (normalized.endsWith("/") ? "" : "/") + "?hl=en",
    ];

    const out = [];
    for (const url of variants) {
      const html = await fetchHtml(url);
      const info = probeHtml(html);
      out.push({ url, ...info });
      if (info.videoUrl) break;
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(out, null, 2));
  } catch (err) {
    console.error("Erro /debug:", err?.message || err);
    res.status(500).send(err?.message || "Erro no debug");
  }
});

/* ---------- Listen ---------- */
const server = app.listen(PORT, "0.0.0.0", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Downloader rodando em ${url}`);
  try {
    void open(url);
  } catch {}
});

/* ================= helpers ================= */

function isYoutubeUrl(u) {
  try {
    const { hostname } = new URL(u);
    return (
      /(^|\.)youtube\.com$/.test(hostname) || /(^|\.)youtu\.be$/.test(hostname)
    );
  } catch {
    return false;
  }
}

function normalizePostUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/?$/, "/")}`;
  } catch {
    return url;
  }
}

function defaultFileName(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const shortcode =
      parts.find((p) => !["p", "reel", "tv"].includes(p)) || "video";
    return `instagram_${shortcode}`;
  } catch {
    return "instagram_video";
  }
}

async function fetchHtml(url) {
  const r = await axios.get(url, {
    headers: HEADERS,
    timeout: 60000,
    maxRedirects: 5,
    validateStatus: () => true,
  });
  if (r.status >= 400)
    throw new Error(`Falha ao abrir ${url} (status ${r.status})`);
  return r.data;
}

async function findVideoUrl(postUrl) {
  const candidates = [
    postUrl,
    postUrl + "embed/captioned/",
    postUrl.replace(/\/$/, "/") + "?hl=en",
  ];
  for (const url of candidates) {
    const html = await fetchHtml(url);
    const found = extractFromHtml(html);
    if (found) return found;
  }
  return null;
}

function probeHtml(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const metas = {
    ogVideo:
      doc.querySelector('meta[property="og:video"], meta[name="og:video"]')
        ?.content || null,
    ogVideoSecure:
      doc.querySelector('meta[property="og:video:secure_url"]')?.content ||
      null,
    twitterStream:
      doc.querySelector('meta[name="twitter:player:stream"]')?.content || null,
  };
  const jsonLd = [...doc.querySelectorAll('script[type="application/ld+json"]')]
    .map((n) => n.textContent?.trim())
    .filter(Boolean)
    .slice(0, 3);
  const scripts = [...doc.querySelectorAll("script")]
    .map((n) => n.textContent?.trim())
    .filter(Boolean);
  const textSample = (s) =>
    s ? (s.length > 1000 ? s.slice(0, 1000) + "..." : s) : null;
  const videoUrl = extractFromHtml(html);
  const bigJson = scripts.find((t) =>
    /video_versions|playable_url|video_url|dash_manifest/.test(t)
  );
  return {
    metas,
    jsonLdFirst: textSample(jsonLd[0]),
    scriptMatchSample: textSample(bigJson),
    videoUrl: videoUrl || null,
  };
}

function extractFromHtml(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  let tag = doc.querySelector(
    'meta[property="og:video"], meta[name="og:video"]'
  );
  if (tag?.content) return tag.content;
  tag = doc.querySelector('meta[property="og:video:secure_url"]');
  if (tag?.content) return tag.content;
  tag = doc.querySelector('meta[name="twitter:player:stream"]');
  if (tag?.content) return tag.content;

  const vtag = doc.querySelector("video");
  if (vtag?.src) return vtag.src;

  const ldBlocks = [
    ...doc.querySelectorAll('script[type="application/ld+json"]'),
  ];
  for (const s of ldBlocks) {
    try {
      const data = JSON.parse(s.textContent.trim());
      const arr = Array.isArray(data) ? data : [data];
      for (const item of arr) {
        if (item && typeof item === "object") {
          if (item.contentUrl) return item.contentUrl;
          if (item.video && item.video.contentUrl) return item.video.contentUrl;
        }
      }
    } catch {}
  }

  const rxList = [
    /"video_versions"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"([^"]+)"/,
    /"playable_url_quality_hd"\s*:\s*"([^"]+)"/,
    /"playable_url"\s*:\s*"([^"]+)"/,
    /"video_url"\s*:\s*"([^"]+)"/,
    /"contentUrl"\s*:\s*"([^"]+)"/,
  ];
  for (const rx of rxList) {
    const m = html.match(rx);
    if (m) {
      try {
        return JSON.parse(`"${m[1]}"`);
      } catch {
        return m[1];
      }
    }
  }

  const dash = html.match(/"dash_manifest"\s*:\s*"([^"]+)"/);
  if (dash) {
    try {
      const manifestXml = JSON.parse(`"${dash[1]}"`);
      const mp4 = manifestXml.match(/BaseURL>([^<]+\.mp4[^<]*)</i);
      if (mp4) return mp4[1];
    } catch {}
  }
  return null;
}

/* ---------- yt-dlp helpers ---------- */

// Pega o título real do vídeo
async function getYoutubeTitle(url) {
  return new Promise((resolve) => {
    try {
      const child = spawn("yt-dlp", ["--no-warnings", "--print", "title", url]);
      let title = "";
      child.stdout.on("data", (chunk) => {
        title += chunk.toString();
      });
      child.on("close", (code) => resolve(code === 0 ? title.trim() : null));
      child.on("error", () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

// Baixa com yt-dlp
function downloadWithYtDlp(
  url,
  res,
  filename = "video.mp4",
  opts = { progressiveOnly: true }
) {
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${sanitizeFilename(filename)}"`
  );

  const formatSelector = opts.progressiveOnly
    ? "best[ext=mp4][acodec!=none]/best[acodec!=none]/best"
    : "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best";

  const baseArgs = [
    "-f",
    formatSelector,
    "--no-playlist",
    "--user-agent",
    HEADERS["User-Agent"],
    "-o",
    "-",
  ];

  const candidates = ["yt-dlp", "yt-dlp.exe", "python", "py"];
  const build = (cmd) =>
    cmd === "python" || cmd === "py"
      ? [cmd, ["-m", "yt_dlp", ...baseArgs, url]]
      : [cmd, [...baseArgs, url]];

  let started = false;
  for (const cmd of candidates) {
    try {
      const [bin, args] = build(cmd);
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

      child.stdout.pipe(res);
      child.stderr.on("data", (d) => process.stderr.write(`[yt-dlp] ${d}`));
      child.on("error", (e) => {
        console.error(`Falha ao executar ${bin}:`, e.message || e);
        if (!res.headersSent)
          res.status(500).send("yt-dlp não encontrado / falhou ao iniciar.");
      });
      child.on("close", (code) => {
        if (code !== 0 && !res.headersSent)
          res.status(500).send(`yt-dlp saiu com código ${code}`);
      });

      started = true;
      break;
    } catch (e) {
      console.error(`Tentativa com ${cmd} falhou:`, e.message || e);
    }
  }

  if (!started && !res.headersSent) {
    res.status(500).send("yt-dlp não encontrado no sistema.");
  }
}

function sanitizeFilename(name = "video") {
  return (
    name
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
      .slice(0, 150)
      .trim() || "video"
  );
}

// Remove dumps automáticos
async function cleanupYtdlDumps(baseDir) {
  try {
    const files = await fs.promises.readdir(baseDir);
    await Promise.all(
      files
        .filter((f) => f.endsWith("-player-script.js"))
        .map((f) => fs.promises.unlink(path.join(baseDir, f)).catch(() => {}))
    );
  } catch {}
}
