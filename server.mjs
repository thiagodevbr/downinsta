import express from "express";
import axios from "axios";
import { JSDOM } from "jsdom";
import path from "path";
import { fileURLToPath } from "url";
import open from "open";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

/** Headers mais realistas (imitando navegador) */
const HEADERS = {
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

app.use(express.static(path.join(__dirname, "public")));

/** Rota raiz */
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/** Rota de download */
app.get("/download", async (req, res) => {
  try {
    const postUrl = req.query.url;
    if (!postUrl) return res.status(400).send("Faltou o parâmetro ?url=");

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

    const r = await axios.get(videoUrl, {
      responseType: "stream",
      headers: HEADERS,
      timeout: 60000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    if (r.status >= 400) {
      return res.status(r.status).send(`Falha ao baixar mídia (${r.status})`);
    }
    r.data.pipe(res);
  } catch (err) {
    console.error("Erro /download:", err?.message);
    res
      .status(err?.response?.status || 500)
      .send(err?.response?.statusText || err?.message || "Erro ao baixar");
  }
});

/** Rota de debug: mostra o que foi encontrado */
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

app.listen(PORT, async () => {
  const url = `http://localhost:${PORT}`;
  console.log(`IG Downloader rodando em ${url}`);
  try {
    await open(url);
  } catch {}
});

/* ----------------- helpers ----------------- */

function normalizePostUrl(url) {
  try {
    const u = new URL(url);
    // remove query e garante barra final
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
  if (r.status >= 400) {
    throw new Error(`Falha ao abrir ${url} (status ${r.status})`);
  }
  return r.data;
}

async function findVideoUrl(postUrl) {
  // tenta em ordem: normal, embed, locale
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

/** Apenas para debug (inspeção amigável) */
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
    .slice(0, 3); // limita a 3 blocos

  const scripts = [...doc.querySelectorAll("script")]
    .map((n) => n.textContent?.trim())
    .filter(Boolean);

  const textSample = (s) =>
    s ? (s.length > 1000 ? s.slice(0, 1000) + "..." : s) : null;

  // tenta extrair semelhante ao extractor
  const videoUrl = extractFromHtml(html);

  // pega primeira ocorrência de objetos grandes que costumam conter mídia
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

/** Extrator agressivo com vários caminhos */
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

  // f) Busca em scripts inline: video_versions, playable_url(_quality_hd), video_url
  // video_versions":[{"type":101,"url":"..."}]
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

  // g) dash_manifest (MPD) → como último recurso, às vezes contém URLs .mp4 segmentadas
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
