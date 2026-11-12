const http = require("http"), { execFile } = require("child_process");
const UA = { "User-Agent": "LyricConstellationLive/1.0" };
const SEP = "\t";
const pc = a => new Promise(r => execFile("playerctl", a, (e, o) => r(e ? "" : o.trim())));
const get = u => fetch(u, { headers: UA, signal: AbortSignal.timeout(8000) });

let cache = { key: "", lines: [], rawTtml: null, source: "auto", loading: false, at: 0 };
let lastPos = 0, lastTime = Date.now();

// LRC timestamps are [mm:ss.xx]; a line may carry several of them
const parseLRC = s => s.split("\n").flatMap(l => {
  const stamps = [...l.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
  const text = l.replace(/\[[^\]]*\]/g, "").replace(/<[^>]*>/g, "").trim();
  return text ? stamps.map(m => [+m[1] * 60 + +m[2], text]) : [];
});

async function getLrcRedLyrics(artist, title) {
  try {
    const r = await get(`https://lrc.red/search.json?q=${encodeURIComponent(artist + " " + title)}`);
    if (!r.ok) return null;
    const hit = (await r.json()).hits?.[0];
    if (!hit?.isrc) return null;
    const t = await get(`https://lrc.red/s/${hit.isrc}.ttml`);
    return t.ok ? { ttml: await t.text() } : null;
  } catch { return null; }
}

async function getLrcLibLyrics(artist, title, album, dur) {
  try {
    const q = new URLSearchParams({ artist_name: artist, track_name: title, album_name: album });
    if (Number.isFinite(dur) && dur > 0) q.set("duration", Math.round(dur));
    let r = await get("https://lrclib.net/api/get?" + q);
    if (r.ok) {
      const j = await r.json();
      if (j.syncedLyrics) return { lines: parseLRC(j.syncedLyrics) };
    }
    r = await get("https://lrclib.net/api/search?q=" + encodeURIComponent(artist + " " + title));
    if (!r.ok) return null;
    const hit = (await r.json()).find(x => x.syncedLyrics);
    return hit ? { lines: parseLRC(hit.syncedLyrics) } : null;
  } catch { return null; }
}

async function getLyrics(artist, title, album, dur) {
  const red = await getLrcRedLyrics(artist, title);
  if (red) return { rawTtml: red.ttml, source: "lrc.red" };
  const lib = await getLrcLibLyrics(artist, title, album, dur);
  if (lib?.lines.length) return { lines: lib.lines, source: "lrclib" };
  return { lines: [], source: "none" };
}

function load(key, artist, title, album, dur) {
  cache.loading = true;
  getLyrics(artist, title, album, dur)
    .then(r => { if (cache.key === key) Object.assign(cache, { lines: r.lines || [], rawTtml: r.rawTtml || null, source: r.source }); })
    .catch(() => { if (cache.key === key) cache.source = "none"; })
    .finally(() => { if (cache.key === key) { cache.loading = false; cache.at = Date.now(); } });
}

http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/now") { res.statusCode = 404; return res.end(); }

  const [meta, posStr, st] = await Promise.all([
    pc(["metadata", "--format", ["{{artist}}", "{{title}}", "{{album}}", "{{mpris:length}}", "{{mpris:artUrl}}"].join(SEP)]),
    pc(["position"]), pc(["status"])
  ]);
  const [artist = "", title = "", album = "", len = "", art = ""] = meta.split(SEP);
  const key = title ? artist + "|" + title : "";
  const now = Date.now();

  // new track: reset before reading position so the reset can't wipe a fresh value
  if (key && cache.key !== key) {
    cache = { key, lines: [], rawTtml: null, source: "auto", loading: false, at: 0 };
    lastPos = 0; lastTime = now;
  }

  let pos = parseFloat(posStr);
  if (isNaN(pos)) pos = st === "Playing" ? lastPos + (now - lastTime) / 1000 : lastPos;
  else { lastPos = pos; lastTime = now; }

  // fetch lyrics once per track; retry a failed lookup every 30s
  if (key && !cache.loading && (cache.source === "auto" || (cache.source === "none" && now - cache.at > 30000)))
    load(key, artist, title, album, +len / 1e6);

  // don't resend big lyric payloads once the client has them
  const has = url.searchParams.get("k") === key && (cache.lines.length || cache.rawTtml);

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    key, title, artist, art,
    pos: pos || 0,
    playing: st === "Playing",
    lines: has ? [] : cache.lines,
    rawTtml: has ? null : cache.rawTtml,
    source: cache.source
  }));
}).listen(8787, "127.0.0.1");
