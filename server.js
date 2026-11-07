const http = require("http"), { execFile } = require("child_process");
const pc = a => new Promise(r => execFile("playerctl", a, (e, o) => r(e ? "" : o.trim())));
let cache = { key: "", lines: [], rawTtml: null, source: "auto" };

let lastValidPos = 0;
let lastValidTime = Date.now();

const parseLRC = s => s.split("\n").flatMap(l => {
  const m = l.match(/^\((\d+):(\d+(?:\.\d+)?)\)(.*)/);
  return m && m[3].trim() ? [[+m[1] * 60 + +m[2], m[3].trim()]] : [];
});

async function getLrcRedLyrics(artist, title) {
  try {
    const searchUrl = `https://lrc.red/search.json?q=${encodeURIComponent(artist + " " + title)}`;
    const r = await fetch(searchUrl, {
      headers: { "User-Agent": "LyricConstellationLive/1.0 (contact@example.com)" }
    });
    if (!r.ok) return null;
    const data = await r.json();
    const hit = data.hits && data.hits[0];
    if (!hit || !hit.isrc) return null;

    const ttmlRes = await fetch(`https://lrc.red/s/${hit.isrc}.ttml`, {
      headers: { "User-Agent": "LyricConstellationLive/1.0 (contact@example.com)" }
    });
    if (!ttmlRes.ok) return null;
    return { ttml: await ttmlRes.text(), source: "lrc.red" };
  } catch {
    return null;
  }
}

async function getLrcLibLyrics(artist, title, album, dur) {
  const q = new URLSearchParams({ artist_name: artist, track_name: title, album_name: album, duration: Math.round(dur) });
  let r = await fetch("https://lrclib.net/api/get?" + q);
  if (r.ok) { const j = await r.json(); if (j.syncedLyrics) return { lines: parseLRC(j.syncedLyrics), source: "lrclib" }; }
  r = await fetch("https://lrclib.net/api/search?q=" + encodeURIComponent(artist + " " + title));
  const hit = (await r.json()).find(x => x.syncedLyrics);
  return hit ? { lines: parseLRC(hit.syncedLyrics), source: "lrclib" } : null;
}

async function getLyrics(artist, title, album, dur) {
  const redResult = await getLrcRedLyrics(artist, title);
  if (redResult) {
    return { rawTtml: redResult.ttml, source: "lrc.red" };
  }
  const libResult = await getLrcLibLyrics(artist, title, album, dur);
  if (libResult) {
    return { lines: libResult.lines, source: "lrclib" };
  }
  return { lines: [], source: "none" };
}

http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url !== "/now") return res.end();
  const [meta, posStr, st] = await Promise.all([
    pc(["metadata", "--format", "{{artist}}|{{title}}|{{album}}|{{mpris:length}}"]),
    pc(["position"]), pc(["status"])
  ]);
  const [artist, title, album, len] = meta.split("|");
  const key = artist + "|" + title;

  const now = Date.now();
  let pos = parseFloat(posStr);

  if (isNaN(pos)) {
    // If playerctl fails, estimate position based on elapsed time if playing
    if (st === "Playing") {
      const elapsed = (now - lastValidTime) / 1000;
      pos = lastValidPos + elapsed;
    } else {
      pos = lastValidPos;
    }
  } else {
    lastValidPos = pos;
    lastValidTime = now;
  }

  if (title && cache.key !== key) {
    cache = { key, lines: [], rawTtml: null, source: "auto" };
    lastValidPos = 0;
    lastValidTime = Date.now();
    getLyrics(artist, title, album, len / 1e6).then(resData => {
      if (cache.key === key) {
        cache.lines = resData.lines || [];
        cache.rawTtml = resData.rawTtml || null;
        cache.source = resData.source;
      }
    }).catch(() => {});
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    key, title, artist,
    pos: pos || 0,
    playing: st === "Playing",
    lines: cache.lines,
    rawTtml: cache.rawTtml,
    source: cache.source
  }));
}).listen(8787);