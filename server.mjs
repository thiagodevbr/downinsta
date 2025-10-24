// server.mjs — IG (legacy) + YouTube (yt-dlp com tmp + fallback)
import express from "express";
import axios from "axios";
import { JSDOM } from "jsdom";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);

/* ----------------- Logs básicos ----------------- */
process.on("unhandledRejection", (err) =>
  console.error("unhandledRejection:", err)
);
process.on("uncaughtException", (err) =>
  console.error("uncaughtException:", err)
);

/* ----------------- IG: headers (versão que funciona) ----------------- */
const IG_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  Referer: "https://www.instagram.com/",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-User": "?1",
  "sec-ch-ua":
    '"Chromium";v="122", "Not(A:Brand";v="8", "Google Chrome";v="122"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

/* ----------------- Static & Health ----------------- */
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.send("ok"));
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

/* ----------------- Download genérico (IG por padrão) ----------------- */
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
          "Não encontrei o vídeo (post privado, sem metatags de mídia, ou layout mudou). Use /debug para investigar."
        );
    }

    const filename = `${defaultFileName(normalized)}.mp4`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "video/mp4");

    const r = await axios.get(videoUrl, {
      responseType: "stream",
      headers: IG_HEADERS,
      timeout: 60000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    if (r.status >= 400)
      return res.status(r.status).send(`Falha ao baixar mídia (${r.status})`);
    r.data.pipe(res);
  } catch (err) {
    console.error("Erro /download:", err?.message || err);
    res
      .status(err?.response?.status || 500)
      .send(err?.response?.statusText || err?.message || "Erro ao baixar");
  }
});

/* ----------------- Download YouTube (tmp + merge; fallback progressivo) ----------------- */
// Download YouTube (tmp + merge; fallback progressivo) usando o caminho final do próprio yt-dlp
app.get("/download-youtube", async (req, res) => {
  try {
    const ytUrl = req.query.url;
    if (!ytUrl)
      return res
        .status(400)
        .send("Use /download-youtube?url=<link do YouTube>");

    const meta = await getYoutubeMeta(ytUrl);
    const id = meta?.id || String(Date.now());
    const title = sanitizeFilename(meta?.title || "youtube_video");

    const outBase = path.join(os.tmpdir(), `yt-${id}`);

    const result = await downloadWithYtDlpToFile(ytUrl, outBase); // { ok, filepath, stderr }

    // Se o yt-dlp reportou o caminho final, usa ele
    let finalPath =
      result.filepath && fs.existsSync(result.filepath)
        ? result.filepath
        : null;

    // Último recurso: procura qualquer arquivo que comece com outBase (exceto .part)
    if (!finalPath) {
      const dir = path.dirname(outBase);
      const baseName = path.basename(outBase);
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(baseName) && !f.endsWith(".part"))
        .map((f) => path.join(dir, f));
      files.sort(
        (a, b) => (fs.statSync(b).size || 0) - (fs.statSync(a).size || 0)
      );
      if (files[0] && fs.statSync(files[0]).size > 0) finalPath = files[0];
    }

    if (!finalPath) {
      console.error("yt-dlp stderr:", result.stderr || "(vazio)");
      return res
        .status(500)
        .send("Falha ao baixar/mesclar vídeo (arquivo não encontrado).");
    }

    // envia com nome bonito (força .mp4 pra baixar padronizado)
    res.setHeader("Content-Disposition", `attachment; filename="${title}.mp4"`);
    res.setHeader("Content-Type", "video/mp4");

    const read = fs.createReadStream(finalPath);
    read.on("error", (e) => {
      console.error("Erro lendo arquivo:", e);
      if (!res.headersSent) res.status(500).send("Erro ao ler arquivo.");
      try {
        res.end();
      } catch {}
    });
    read.pipe(res);

    const cleanup = async () => {
      // remove todos os arquivos relacionados a esse download
      const dir = path.dirname(outBase);
      const baseName = path.basename(outBase);
      fs.readdir(dir, (err, list) => {
        if (err) return;
        list
          .filter((f) => f.startsWith(baseName))
          .forEach((f) => {
            fs.promises.unlink(path.join(dir, f)).catch(() => {});
          });
      });
    };
    res.on("finish", cleanup);
    res.on("close", cleanup);
  } catch (err) {
    console.error("Erro /download-youtube:", err?.message || err);
    res.status(500).send(err?.message || "Erro ao processar vídeo do YouTube.");
  }
});

/* ----------------- Debug IG ----------------- */
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
      if (info.videoUrl) break; // achou, pode parar
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(out, null, 2));
  } catch (err) {
    res.status(500).send(err?.message || "Erro no debug");
  }
});

/* ----------------- Listen ----------------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server on :${PORT}`);
});

/* ================= IG helpers (legado) ================= */
// coloque no topo das helpers do YouTube
const YTDLP_COMMON = [
  "--force-ipv4",
  "--geo-bypass",
  "--no-check-certificates",
  "--extractor-args",
  "youtube:player_client=android,player_skip=webpage",
  // alternativas possíveis se ainda falhar:
  // "--extractor-args", "youtube:player_client=ios,player_skip=webpage"
];

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
    headers: IG_HEADERS,
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

  // a) og:video
  let tag = doc.querySelector(
    'meta[property="og:video"], meta[name="og:video"]'
  );
  if (tag?.content) return tag.content;

  // b) og:video:secure_url
  tag = doc.querySelector('meta[property="og:video:secure_url"]');
  if (tag?.content) return tag.content;

  // c) twitter:player:stream
  tag = doc.querySelector('meta[name="twitter:player:stream"]');
  if (tag?.content) return tag.content;

  // d) <video src="...">
  const vtag = doc.querySelector("video");
  if (vtag?.src) return vtag.src;

  // e) JSON-LD contentUrl
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

  // f) Busca em scripts inline
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

  // g) dash_manifest (último recurso)
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

/* ================= YouTube helpers ================= */

// Pega id + título rapidamente
function getYoutubeMeta(url) {
  return new Promise((resolve) => {
    try {
      const args = [
        ...YTDLP_COMMON,
        "--no-warnings",
        "--print",
        "%(id)s\t%(title)s",
        url,
      ];
      const child = spawn("yt-dlp", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "",
        err = "";
      child.stdout.on("data", (c) => (out += c.toString()));
      child.stderr.on("data", (d) => process.stderr.write(`[yt-dlp] ${d}`));
      child.on("close", (code) => {
        if (code === 0 && out.trim()) {
          const [id, title] = out.trim().split("\t");
          resolve({ id, title });
        } else resolve(null);
      });
      child.on("error", () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

// Baixa para arquivo; tenta MERGE (ffmpeg). Se falhar, cai para PROGRESSIVO (sem ffmpeg).
// Baixa para arquivo e retorna o caminho FINAL impresso pelo yt-dlp.
// Tenta MERGE (ffmpeg) com remux em mp4; se falhar, cai para PROGRESSIVO.
// Usa --print after_move:filepath (ou filepath) para capturar o destino final.
function downloadWithYtDlpToFile(url, outBaseNoExt) {
  return new Promise((resolve) => {
    let stderrBuf = "",
      stdoutBuf = "";

    const run = (args) =>
      new Promise((res) => {
        const child = spawn("yt-dlp", [...args, url], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.on("data", (d) => (stdoutBuf += d.toString()));
        child.stderr.on("data", (d) => {
          stderrBuf += d.toString();
          process.stderr.write(`[yt-dlp] ${d}`);
        });
        child.on("error", (e) => res({ code: 1, error: e }));
        child.on("close", (code) => res({ code }));
      });

    (async () => {
      // A) melhor qualidade com merge (mp4) — requer ffmpeg
      stdoutBuf = "";
      stderrBuf = "";
      let argsMerge = [
        ...YTDLP_COMMON,
        "-f",
        "bv*+ba/best",
        "--no-playlist",
        "--merge-output-format",
        "mp4",
        "--restrict-filenames",
        "-o",
        `${outBaseNoExt}.%(ext)s`,
        "--user-agent",
        "Mozilla/5.0",
        "--print",
        "after_move:filepath",
        "--print",
        "filepath",
      ];
      let r = await run(argsMerge);

      // B) fallback progressivo (sem merge)
      if (r.code !== 0) {
        stdoutBuf = ""; // só capturar do fallback
        let argsProg = [
          ...YTDLP_COMMON,
          "-f",
          "best[ext=mp4][acodec!=none]/best[acodec!=none]/best",
          "--no-playlist",
          "--restrict-filenames",
          "-o",
          `${outBaseNoExt}.%(ext)s`,
          "--user-agent",
          "Mozilla/5.0",
          "--print",
          "after_move:filepath",
          "--print",
          "filepath",
        ];
        r = await run(argsProg);
      }

      const lines = stdoutBuf
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const filepath = lines.length ? lines[lines.length - 1] : null;

      resolve({
        ok: r.code === 0,
        filepath: filepath && fs.existsSync(filepath) ? filepath : null,
        stderr: stderrBuf,
      });
    })();
  });
}

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

function sanitizeFilename(name = "video") {
  return (
    name
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
      .slice(0, 150)
      .trim() || "video"
  );
}
