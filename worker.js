// Tweetober 5 - serves the site, plus a tiny message board API for The Hall.
//
//   GET    /api/messages            -> latest 60 messages (oldest first)
//   GET    /api/messages?after=ID   -> only messages newer than ID
//   POST   /api/messages            -> { name, color, body, code }  (code must match HALL_CODE)
//                                      a body of "/flip" (optionally followed by a question) is turned into a coin toss
//   DELETE /api/messages?id=ID      -> remove one (header  x-admin-key: ADMIN_KEY)
//   GET    /api/trumpet              -> { count }   how many times the trumpet has been sounded
//   POST   /api/trumpet              -> { count }   sound it once more
//   GET    /api/feed                 -> { tweets, fetched }  the Tweetober list, via twitterapi.io, cached
//   GET    /api/tweets?ids=A,B       -> { tweets }  Trophy Room tweets (only ones linked in the sheet), cached
//   GET    /api/oath                 -> { oaths }   the Roll of the Sworn: handle + drawn signature
//   POST   /api/oath                 -> { name, sig }  sign the Honor Code (one oath per handle)
//
// Settings (Cloudflare dashboard -> this Worker -> Settings -> Variables and Secrets):
//   HALL_CODE  secret  optional. Leave unset and anyone can post. Set it (e.g. hinge) to require a password.
//   ADMIN_KEY  secret  any long random string; lets you delete messages.
//   TWITTERAPI_KEY  secret  your twitterapi.io API key. Without it the Scrying Glass shows a link to the list instead.
//   LIST_ID         text    optional. The Twitter list to show. Defaults to the Tweetober 2026 list below.
//   FEED_MINUTES    text    optional. How often to check for new tweets (default 1).
//                           Each check asks only for tweets posted since the last one, so you mostly pay for new tweets.
//                           Nothing is fetched while nobody has the site open.

const COLORS = ["#F26F96", "#E6E4E0", "#F2D272", "#B99CFF", "#8CC8FF", "#8FE3B6", "#FF9D5C", "#FFB3C7"];
const MAX_NAME = 25, MAX_BODY = 280, COOLDOWN_MS = 8000, PAGE = 60;

let ready = false;
async function ensureTable(db) {
  if (ready) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, who TEXT)"
  ).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS messages_who ON messages (who, created)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS feed_cache (id INTEGER PRIMARY KEY, body TEXT NOT NULL, fetched INTEGER NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS oaths (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, sig TEXT NOT NULL, created INTEGER NOT NULL, who TEXT)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS tweet_cache (id TEXT PRIMARY KEY, body TEXT NOT NULL, fetched INTEGER NOT NULL)").run();
  ready = true;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const clean = (s, max) =>
  String(s ?? "").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

async function who(request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("tweetober:" + ip));
  return [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function handle(request, env, url) {
  if (!env.DB) return json({ error: "The message board isn't connected to a database yet." }, 503);
  await ensureTable(env.DB);

  if (request.method === "GET") {
    const after = Number(url.searchParams.get("after")) || 0;
    const q = after
      ? env.DB.prepare("SELECT id, name, color, body, created FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?").bind(after, PAGE)
      : env.DB.prepare("SELECT * FROM (SELECT id, name, color, body, created FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id ASC").bind(PAGE);
    const { results } = await q.all();
    return json({ messages: results, needsCode: !!env.HALL_CODE });
  }

  if (request.method === "POST") {
    let input;
    try { input = await request.json(); } catch { return json({ error: "That message couldn't be read." }, 400); }
    if (env.HALL_CODE && clean(input.code, 64).toLowerCase() !== String(env.HALL_CODE).trim().toLowerCase())
      return json({ error: "The gate does not open. Check the password." }, 403);
    const name = clean(input.name, MAX_NAME);
    let body = clean(input.body, MAX_BODY);
    const color = COLORS.includes(input.color) ? input.color : COLORS[0];
    if (!name) return json({ error: "Give yourself a name first." }, 400);
    if (!body) return json({ error: "Write something to post." }, 400);
    // "/flip" tosses a coin on the server, so nobody can rig it. Heads is House of 333, tails is House of 500.
    const flip = body.match(/^\/flip\b\s*(.*)$/i);
    if (flip) {
      const heads = (crypto.getRandomValues(new Uint32Array(1))[0] & 1) === 0;
      const rest = flip[1].trim().slice(0, 120);
      body = "\u{1FA99} " + (heads ? "Heads! The silver side. House of 333 wins the toss." : "Tails! The pink side. House of 500 wins the toss.")
        + (rest ? " \u2014 \u201c" + rest + "\u201d" : "");
    }
    const id = await who(request), now = Date.now();
    const last = await env.DB.prepare("SELECT created FROM messages WHERE who = ? ORDER BY created DESC LIMIT 1").bind(id).first();
    if (last && now - last.created < COOLDOWN_MS)
      return json({ error: "Slow down, herald. Try again in a few seconds." }, 429);
    const row = await env.DB.prepare("INSERT INTO messages (name, color, body, created, who) VALUES (?, ?, ?, ?, ?) RETURNING id, name, color, body, created")
      .bind(name, color, body, now, id).first();
    return json({ message: row }, 201);
  }

  if (request.method === "DELETE") {
    if (!env.ADMIN_KEY || request.headers.get("x-admin-key") !== env.ADMIN_KEY) return json({ error: "Not allowed." }, 403);
    const target = Number(url.searchParams.get("id"));
    if (!target) return json({ error: "Which message? Add ?id=" }, 400);
    await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(target).run();
    return json({ deleted: target });
  }

  return json({ error: "Method not allowed." }, 405);
}

/* ---------- The Honor Code: signed oaths ----------
   A signature is a list of pen strokes, each a flat list of x,y points on a 1000 x 300 sheet.
   To remove one: D1 console -> DELETE FROM oaths WHERE name = 'handle'; */
function cleanSig(sig) {
  if (!Array.isArray(sig) || !sig.length || sig.length > 60) return null;
  let points = 0, ink = 0;
  const out = [];
  for (const stroke of sig) {
    if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length % 2) return null;
    const st = [];
    for (let i = 0; i < stroke.length; i += 2) {
      const x = Math.round(Number(stroke[i])), y = Math.round(Number(stroke[i + 1]));
      if (!(x >= 0 && x <= 1000 && y >= 0 && y <= 300)) return null;
      if (st.length) ink += Math.hypot(x - st[st.length - 2], y - st[st.length - 1]);
      st.push(x, y);
    }
    points += st.length / 2; out.push(st);
  }
  if (points > 2500 || ink < 60) return null;   // too long, or barely a mark
  return out;
}
async function oath(request, env) {
  if (!env.DB) return json({ error: "No database." }, 503);
  await ensureTable(env.DB);
  if (request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT id, name, sig, created FROM oaths ORDER BY id DESC LIMIT 1000").all();
    return json({ oaths: results.map(r => ({ ...r, sig: JSON.parse(r.sig) })) });
  }
  if (request.method === "POST") {
    let input;
    try { input = await request.json(); } catch { return json({ error: "That oath couldn't be read." }, 400); }
    const name = String(input.name || "").trim().replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{1,15}$/.test(name)) return json({ error: "Sign with your Twitter handle (letters, numbers and _ only)." }, 400);
    const sig = cleanSig(input.sig);
    if (!sig) return json({ error: "Draw your signature on the line first." }, 400);
    const id = await who(request), now = Date.now();
    const last = await env.DB.prepare("SELECT created FROM oaths WHERE who = ? ORDER BY created DESC LIMIT 1").bind(id).first();
    if (last && now - last.created < 10000) return json({ error: "Wait a moment before swearing again." }, 429);
    const taken = await env.DB.prepare("SELECT id FROM oaths WHERE name = ?").bind(name).first();
    if (taken) return json({ error: `@${name} has already sworn the oath.` }, 409);
    const row = await env.DB.prepare("INSERT INTO oaths (name, sig, created, who) VALUES (?, ?, ?, ?) RETURNING id, name, sig, created")
      .bind(name, JSON.stringify(sig), now, id).first();
    return json({ oath: { ...row, sig } }, 201);
  }
  return json({ error: "Method not allowed." }, 405);
}

async function trumpet(request, env) {
  if (!env.DB) return json({ error: "No database." }, 503);
  await ensureTable(env.DB);
  if (request.method === "POST") {
    const row = await env.DB.prepare(
      "INSERT INTO counters (name, value) VALUES ('trumpet', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value"
    ).first();
    return json({ count: row.value });
  }
  const row = await env.DB.prepare("SELECT value FROM counters WHERE name = 'trumpet'").first();
  return json({ count: row ? row.value : 0 });
}

/* ---------- The Scrying Glass: the Tweetober list from twitterapi.io, fetched at most every FEED_MINUTES ---------- */
const DEFAULT_LIST = "2103930993988235727";
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function when(s) {
  // "Tue Oct 06 21:04:11 +0000 2026" (Twitter style) or ISO
  const m = String(s || "").match(/^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) \+0000 (\d{4})$/);
  if (m) return Date.UTC(+m[6], MONTHS[m[1]] ?? 0, +m[2], +m[3], +m[4], +m[5]);
  const t = Date.parse(s); return isNaN(t) ? 0 : t;
}
// Attached photos, GIFs and videos. twitterapi.io has used a few shapes for these, so accept any of them,
// and keep only Twitter's own media hosts.
const TW_MEDIA = /^https:\/\/(pbs|video)\.twimg\.com\//;
function mediaOf(t, depth = 0) {
  const lists = [t.media, t.extendedEntities?.media, t.extended_entities?.media, t.entities?.media].filter(Array.isArray);
  // a retweet carries its pictures on the original tweet
  if (!lists.some(l => l.length) && depth < 1) {
    const inner = t.retweeted_tweet || t.retweetedTweet || t.retweeted_status || t.quoted_tweet || t.quotedTweet || t.quoted_status;
    if (inner && typeof inner === "object") return mediaOf(inner, depth + 1);
  }
  const seen = new Set(), out = [];
  for (const list of lists) for (const m of list) {
    if (!m) continue;
    const type = String(m.type || "photo");
    const img = [m.media_url_https, m.media_url, m.preview_image_url, m.url].find(u => TW_MEDIA.test(String(u || ""))) || "";
    const variants = m.video_info?.variants || m.variants || [];
    const mp4 = variants.filter(v => /mp4/.test(v.content_type || v.contentType || "") && TW_MEDIA.test(String(v.url || "")))
      .sort((x, y) => (y.bitrate || y.bit_rate || 0) - (x.bitrate || x.bit_rate || 0));
    const pick = type === "animated_gif" ? mp4[0] : (mp4.find(v => (v.bitrate || v.bit_rate || 0) <= 2200000) || mp4[mp4.length - 1]);
    const key = img || pick?.url; if (!key || seen.has(key)) continue; seen.add(key);
    out.push({ type: type === "animated_gif" ? "gif" : type === "video" ? "video" : "photo", img, video: pick ? String(pick.url) : "",
      w: m.original_info?.width || m.sizes?.large?.w || m.width || 0, h: m.original_info?.height || m.sizes?.large?.h || m.height || 0 });
    if (out.length >= 4) break;
  }
  return out;
}
const slim = (t) => ({
  id: String(t.id || ""), url: String(t.url || ""), text: String(t.text || "").slice(0, 1200),
  created: when(t.createdAt), likes: t.likeCount | 0, retweets: t.retweetCount | 0, replies: t.replyCount | 0,
  isReply: !!t.isReply, replyTo: t.inReplyToUsername ? String(t.inReplyToUsername) : "", media: mediaOf(t),
  author: { userName: String(t.author?.userName || ""), name: String(t.author?.name || ""), avatar: String(t.author?.profilePicture || "") },
});
async function fetchPage(env, params) {
  const u = new URL("https://api.twitterapi.io/twitter/list/tweets");
  u.searchParams.set("listId", env.LIST_ID || DEFAULT_LIST);
  u.searchParams.set("includeReplies", "false");
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  const r = await fetch(u, { headers: { "X-API-Key": env.TWITTERAPI_KEY } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !Array.isArray(data.tweets)) throw new Error(data.message || data.msg || ("HTTP " + r.status));
  return data;
}
const KEEP = 60;          // tweets kept in the cache and served to the page
const MAX_PAGES = 6;      // at most 120 tweets per catch-up, so a busy minute can't run up the bill
const CATCHUP_MS = 15 * 60000;   // if the cache is older than this, just take the latest page rather than back-filling
async function feed(env) {
  if (!env.TWITTERAPI_KEY) return json({ error: "not configured" }, 503);
  if (!env.DB) return json({ error: "No database." }, 503);
  await ensureTable(env.DB);
  const ttl = Math.max(1, Number(env.FEED_MINUTES) || 1) * 60000, now = Date.now();
  const row = await env.DB.prepare("SELECT body, fetched FROM feed_cache WHERE id = 1").first();
  const cached = row ? JSON.parse(row.body) : [];
  if (row && now - row.fetched < ttl) return json({ tweets: cached, fetched: row.fetched });
  // claim the refresh so simultaneous visitors don't each pay for a fetch
  const claim = await env.DB.prepare(
    "INSERT INTO feed_cache (id, body, fetched) VALUES (1, '[]', ?) ON CONFLICT(id) DO UPDATE SET fetched = excluded.fetched WHERE feed_cache.fetched <= ?"
  ).bind(now, now - ttl).run();
  if (row && !claim.meta.changes) return json({ tweets: cached, fetched: row.fetched });
  try {
    // tweets cached before media support have no "media" field; start fresh once so they pick up their pictures
    const oldFormat = cached.some(t => !Array.isArray(t.media));
    const newest = oldFormat ? 0 : cached.reduce((m, t) => Math.max(m, t.created || 0), 0);
    const seen = new Set(cached.map(t => t.id));
    let fresh = [];
    if (newest && now - newest < CATCHUP_MS && row && now - row.fetched < CATCHUP_MS) {
      // only what's been posted since the newest tweet we already have
      let cursor = "", pages = 0;
      do {
        const data = await fetchPage(env, { sinceTime: Math.floor(newest / 1000), cursor });
        const got = data.tweets.filter(t => t && t.id && !seen.has(String(t.id))).map(slim);
        got.forEach(t => seen.add(t.id)); fresh.push(...got);
        cursor = data.has_next_page && data.next_cursor && got.length ? data.next_cursor : "";
      } while (cursor && ++pages < MAX_PAGES);
    } else {
      // first fetch, or the glass sat unwatched for a while: just the latest page
      const data = await fetchPage(env, {});
      fresh = data.tweets.filter(t => t && t.id).map(slim);
      seen.clear(); cached.length = 0;
    }
    const tweets = [...fresh, ...cached].sort((a, b) => b.created - a.created).slice(0, KEEP);
    await env.DB.prepare("UPDATE feed_cache SET body = ?, fetched = ? WHERE id = 1").bind(JSON.stringify(tweets), now).run();
    return json({ tweets, fetched: now, added: fresh.length });
  } catch (e) {
    // keep serving the last good copy; try again after the next interval
    if (row) return json({ tweets: cached, fetched: row.fetched, stale: true });
    return json({ error: "The feed could not be fetched.", detail: String(e.message || e).slice(0, 200) }, 502);
  }
}

/* ---------- The Trophy Room: the tweets linked in the sheet's Trophy Room tab, drawn by the page in house colors ----------
   Only tweets that are actually linked in the Trophy Room tab are fetched, so nobody can use this to run up the bill.
   Each tweet is re-checked at most every TROPHY_MINUTES (default 30) to keep like counts fresh. */
const TROPHY_SHEET = "https://docs.google.com/spreadsheets/d/1b3AqoSgvyc1s-21rQQuVK0-HBeTz6cZVUJuWW9BRKy4/gviz/tq?tqx=out:csv&sheet=Trophy%20Room";
async function trophies(env, url) {
  if (!env.TWITTERAPI_KEY) return json({ error: "not configured" }, 503);
  if (!env.DB) return json({ error: "No database." }, 503);
  await ensureTable(env.DB);
  const ids = [...new Set(String(url.searchParams.get("ids") || "").split(",").map(x => x.trim()).filter(x => /^\d{5,25}$/.test(x)))].slice(0, 60);
  if (!ids.length) return json({ tweets: [] });
  const ttl = Math.max(5, Number(env.TROPHY_MINUTES) || 30) * 60000, now = Date.now();
  const marks = ids.map(() => "?").join(",");
  const rows = (await env.DB.prepare(`SELECT id, body, fetched FROM tweet_cache WHERE id IN (${marks})`).bind(...ids).all()).results || [];
  const have = new Map(rows.map(r => [r.id, r]));
  let need = ids.filter(id => !have.has(id) || now - have.get(id).fetched > ttl);
  if (need.length) {
    try {
      // only tweets that are really in the Trophy Room tab
      const sheet = await (await fetch(env.TROPHY_CSV || TROPHY_SHEET, { cf: { cacheTtl: 60 } })).text();
      const listed = new Set([...sheet.matchAll(/status(?:es)?\/(\d{5,25})/g)].map(m => m[1]));
      need = need.filter(id => listed.has(id));
      if (need.length) {
        const u = new URL("https://api.twitterapi.io/twitter/tweets");
        u.searchParams.set("tweet_ids", need.join(","));
        const r = await fetch(u, { headers: { "X-API-Key": env.TWITTERAPI_KEY } });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !Array.isArray(data.tweets)) throw new Error(data.message || data.msg || ("HTTP " + r.status));
        const got = new Map(data.tweets.filter(t => t && t.id).map(t => [String(t.id), slim(t)]));
        const stmt = env.DB.prepare("INSERT INTO tweet_cache (id, body, fetched) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, fetched = excluded.fetched");
        // a tweet that didn't come back (deleted or private) is remembered as missing, so it isn't asked for on every visit
        await env.DB.batch(need.map(id => stmt.bind(id, JSON.stringify(got.get(id) || { id, missing: true }), now)));
        need.forEach(id => have.set(id, { id, body: JSON.stringify(got.get(id) || { id, missing: true }), fetched: now }));
      }
    } catch (e) {
      if (!have.size) return json({ error: "The tweets could not be fetched.", detail: String(e.message || e).slice(0, 200) }, 502);
    }
  }
  const tweets = ids.map(id => have.get(id)).filter(Boolean).map(r => JSON.parse(r.body));
  return json({ tweets });
}

/* ---------- Private report for the organizers ----------
   /api/day?key=ADMIN_KEY   today's tweets (New York time) and the month so far, from everyone on the list:
   tweets per house, the most-liked tweets and tweets per person.
   Each finished day is scanned once after it ends; today is re-scanned at most every REPORT_MINUTES (default 30)
   so like counts stay fresh. The page refreshes itself while a scan is running. &fresh=1 re-scans today now. */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const page = (title, body, refresh) => new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${refresh ? `<meta http-equiv="refresh" content="${esc(refresh)}">` : ""}<title>${esc(title)}</title>
<style>body{font:15px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#1c150e;color:#f3e6c8;margin:0;padding:20px}main{max-width:820px;margin:0 auto}h1{color:#f2d272;font-size:1.5rem}h3{color:#e9d6a8;font-size:1rem;margin-top:18px}details{margin-top:14px}summary{cursor:pointer;color:#f2d272}h2{color:#f2d272;font-size:1.1rem;margin-top:28px}table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid #4a3a24;text-align:left;vertical-align:top}th{color:#c9b48a;font-weight:600}.n{text-align:right;white-space:nowrap}a{color:#f2d272}.muted{color:#a8957a}.h333{color:#e6e4e0}.h500{color:#f26f96}</style></head><body><main>${body}</main></body></html>`,
  { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
const LEDGER_SHEET = "https://docs.google.com/spreadsheets/d/1b3AqoSgvyc1s-21rQQuVK0-HBeTz6cZVUJuWW9BRKy4/gviz/tq?tqx=out:csv";
function csvRows(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
// handle (lowercase) -> "333" or "500", read from the Ledger sheet
async function ledgerHouses(env) {
  const map = {};
  try {
    const rows = csvRows(await (await fetch(env.LEDGER_CSV || LEDGER_SHEET, { cf: { cacheTtl: 120 } })).text());
    const hi = rows.findIndex(r => r.some(v => /handle/i.test(v))); if (hi < 0) return map;
    const head = rows[hi].map(h => h.trim().toLowerCase());
    const iH = head.findIndex(h => /handle|name|user/.test(h));
    let iHouse = head.findIndex(h => /house/.test(h)); if (iHouse < 0) iHouse = iH + 1;
    for (const r of rows.slice(hi + 1)) {
      const h = String(r[iH] || "").trim().replace(/^@/, "").toLowerCase(), m = String(r[iHouse] || "").match(/333|500/);
      if (h && !/\s/.test(h) && m) map[h] = m[0];
    }
  } catch {}
  return map;
}
const DAY_MS = 864e5, OCT1 = Date.UTC(2026, 9, 1, 4);   // midnight Oct 1, New York (EDT)
const dayStart = (d) => OCT1 + (d - 1) * DAY_MS;
const blankDay = () => ({ users: {}, top: [], ids: [], n: { tweet: 0, quote: 0, reply: 0, retweet: 0 } });
// one chunk of a day's scan: up to 25 pages of the list, folded into that day's running totals
async function scanChunk(env, d, st, until) {
  const start = dayStart(d), seen = new Set(st.data.ids);
  for (let i = 0; i < 25; i++) {
    const u = new URL("https://api.twitterapi.io/twitter/list/tweets");
    u.searchParams.set("listId", env.LIST_ID || DEFAULT_LIST); u.searchParams.set("includeReplies", "true");
    u.searchParams.set("sinceTime", String(Math.floor(start / 1000))); u.searchParams.set("untilTime", String(Math.floor(until / 1000)));
    if (st.cursor) u.searchParams.set("cursor", st.cursor);
    const r = await fetch(u, { headers: { "X-API-Key": env.TWITTERAPI_KEY } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(data.tweets)) throw new Error("twitterapi.io: " + (data.message || data.msg || r.status));
    let older = false;
    for (const t of data.tweets) {
      const created = when(t.createdAt), id = String(t.id || "");
      if (created && created < start) older = true;
      if (!id || seen.has(id) || created < start || created >= until) continue;
      seen.add(id); st.data.ids.push(id);
      const user = String(t.author?.userName || "");
      const kind = (t.retweeted_tweet || t.retweetedTweet || /^RT @/.test(t.text || "")) ? "retweet"
        : (t.isReply && String(t.inReplyToUsername || "").toLowerCase() !== user.toLowerCase()) ? "reply"
        : (t.quoted_tweet || t.quotedTweet) ? "quote" : "tweet";
      st.data.n[kind]++;
      const p = st.data.users[user] ||= [0, 0, 0, 0];   // counted, likes on counted, replies, retweets
      if (kind === "reply") p[2]++; else if (kind === "retweet") p[3]++; else {
        p[0]++; p[1] += t.likeCount | 0;
        st.data.top.push([user, id, t.likeCount | 0, t.retweetCount | 0, String(t.text || "").slice(0, 160)]);
        if (st.data.top.length > 40) { st.data.top.sort((a, b) => b[2] - a[2]); st.data.top.length = 30; }
      }
    }
    st.cursor = data.has_next_page && data.next_cursor && data.tweets.length && !older ? data.next_cursor : "";
    if (!st.cursor) return true;
  }
  return false;
}
async function dayReport(request, env, url) {
  if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) return page("Not allowed", "<h1>Not allowed</h1><p>Add <code>?key=</code> with your ADMIN_KEY.</p>");
  if (!env.TWITTERAPI_KEY || !env.DB) return page("Not set up", "<h1>Not set up</h1><p>TWITTERAPI_KEY or the database is missing.</p>");
  const now = Date.now();
  const today = Math.max(1, Math.min(31, Math.floor((now - OCT1) / DAY_MS) + 1));
  const ttl = Math.max(5, Number(env.REPORT_MINUTES) || 30) * 60000;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS report_days (day INTEGER PRIMARY KEY, data TEXT NOT NULL, cursor TEXT, scanning INTEGER NOT NULL, final INTEGER NOT NULL, scanned INTEGER NOT NULL, upto INTEGER NOT NULL)").run();
  const { results } = await env.DB.prepare("SELECT * FROM report_days").all();
  const rows = Object.fromEntries(results.map(r => [r.day, r]));
  // what needs scanning: a finished day that was never scanned after it ended, or today if it's stale (or &fresh=1)
  let job = null;
  for (let d = 1; d <= today && !job; d++) {
    const r = rows[d], ended = now >= dayStart(d) + DAY_MS;
    if (r && r.scanning) job = d;
    else if (ended && !(r && r.final)) job = d;
    else if (!ended && (!r || now - r.scanned > ttl || (url.searchParams.get("fresh") && !url.searchParams.get("cont")))) job = d;
  }
  if (job && now <= dayStart(31) + 2 * DAY_MS) {
    const r = rows[job], cont = r && r.scanning;
    const st = cont ? { data: JSON.parse(r.data), cursor: r.cursor || "" } : { data: blankDay(), cursor: "" };
    const until = cont ? r.upto : Math.min(now, dayStart(job) + DAY_MS);
    let done;
    try { done = await scanChunk(env, job, st, until); }
    catch (e) { return page("Error", `<h1>Couldn't scan</h1><p>${esc(e.message || e)}</p><p><a href="">Try again</a></p>`); }
    if (done) { st.data.top.sort((a, b) => b[2] - a[2]); st.data.top.length = Math.min(st.data.top.length, 30); }
    await env.DB.prepare("INSERT INTO report_days (day, data, cursor, scanning, final, scanned, upto) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET data = excluded.data, cursor = excluded.cursor, scanning = excluded.scanning, final = excluded.final, scanned = excluded.scanned, upto = excluded.upto")
      .bind(job, JSON.stringify(st.data), st.cursor, done ? 0 : 1, done && until >= dayStart(job) + DAY_MS ? 1 : 0, now, until).run();
    const k = encodeURIComponent(url.searchParams.get("key"));
    return page("Scanning", `<h1>Scanning October ${job}&hellip;</h1><p>${st.data.ids.length} posts so far. This page refreshes itself until it's done.</p>`, `1;url=?key=${k}&cont=1`);
  }
  // ---- render ----
  const days = Object.fromEntries(results.map(r => [r.day, JSON.parse(r.data)]));
  const houses = await ledgerHouses(env), houseOf = (u) => houses[String(u).toLowerCase()] || "";
  const H = { "333": { name: "House of 333", cls: "h333" }, "500": { name: "House of 500", cls: "h500" }, "": { name: "Not in the Ledger", cls: "muted" } };
  const who = (u) => `<span class="${H[houseOf(u)].cls}">@${esc(u)}</span>`;
  function section(title, list) {
    const users = {}, n = { tweet: 0, quote: 0, reply: 0, retweet: 0 }; let top = [];
    for (const d of list) {
      for (const [u, v] of Object.entries(d.users)) { const p = users[u] ||= [0, 0, 0, 0]; v.forEach((x, i) => p[i] += x); }
      for (const k in n) n[k] += d.n[k] || 0;
      top = top.concat(d.top);
    }
    top.sort((a, b) => b[2] - a[2] || b[3] - a[3]); top = top.slice(0, 10);
    const hs = { "333": [0, 0, 0, 0, 0], "500": [0, 0, 0, 0, 0], "": [0, 0, 0, 0, 0] };
    for (const [u, p] of Object.entries(users)) { const h = hs[houseOf(u)]; p.forEach((x, i) => h[i] += x); h[4]++; }
    const lead = hs["333"][0] === hs["500"][0] ? "Dead even." : `${hs["333"][0] > hs["500"][0] ? "House of 333" : "House of 500"} leads by ${Math.abs(hs["333"][0] - hs["500"][0]).toLocaleString("en-US")}.`;
    const people = Object.entries(users).sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1]);
    const f = (x) => Number(x).toLocaleString("en-US");
    return `<h2>${title}</h2>
      <p class="muted">${f(n.tweet + n.quote + n.reply + n.retweet)} posts: ${f(n.tweet)} tweets, ${f(n.quote)} quote tweets, ${f(n.reply)} replies to others, ${f(n.retweet)} retweets.</p>
      <h3>Tweets per house</h3><p>${lead}</p>
      <table><tr><th>House</th><th class="n">Counted tweets</th><th class="n">Likes on them</th><th class="n">People posting</th><th class="n">Replies</th><th class="n">Retweets</th></tr>
      ${["333", "500", ""].filter(k => k || hs[k][4]).map(k => `<tr><td class="${H[k].cls}">${H[k].name}</td><td class="n">${f(hs[k][0])}</td><td class="n">${f(hs[k][1])}</td><td class="n">${hs[k][4]}</td><td class="n">${f(hs[k][2])}</td><td class="n">${f(hs[k][3])}</td></tr>`).join("")}</table>
      <h3>Top 10 most liked</h3>
      <table><tr><th>#</th><th>Who</th><th>Tweet</th><th class="n">Likes</th><th class="n">RTs</th></tr>
      ${top.map((t, i) => `<tr><td>${i + 1}</td><td>${who(t[0])}</td><td><a href="https://x.com/${esc(t[0])}/status/${esc(t[1])}" target="_blank" rel="noopener">${esc(t[4]) || "(media)"}</a></td><td class="n">${f(t[2])}</td><td class="n">${f(t[3])}</td></tr>`).join("")}</table>
      <details><summary>Tweets per person (${people.length})</summary>
      <table><tr><th>#</th><th>Who</th><th class="n">Counted</th><th class="n">Likes on them</th><th class="n">Replies</th><th class="n">Retweets</th></tr>
      ${people.map(([u, p], i) => `<tr><td>${i + 1}</td><td>${who(u)}</td><td class="n">${f(p[0])}</td><td class="n">${f(p[1])}</td><td class="n">${f(p[2])}</td><td class="n">${f(p[3])}</td></tr>`).join("")}</table></details>`;
  }
  const ny = (t) => new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const tRow = rows[today], k = encodeURIComponent(url.searchParams.get("key"));
  const monthDays = Object.keys(days).map(Number).filter(d => d <= today).map(d => days[d]);
  return page("Tweetober report", `<h1>Tweetober report</h1>
    <p class="muted">"Counted" = original tweets, quote tweets and replies to yourself (threads), per the rules. Houses come from the Ledger; "Not in the Ledger" is anyone on the list who isn't in it or is spelled differently there.</p>
    ${days[today] ? section(`Today &middot; October ${today}`, [days[today]]) : ""}
    <p class="muted">Today's likes as of ${tRow ? esc(ny(tRow.scanned)) : "-"} (re-checked at most every ${Math.round(ttl / 60000)} minutes). <a href="?key=${k}&fresh=1">Re-check now</a></p>
    ${section(`October so far &middot; days 1&ndash;${today}`, monthDays)}
    <p class="muted">Finished days are counted once, shortly after they end, so their like counts are from then.</p>`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/feed") {
      try { return await feed(env); }
      catch (e) { return json({ error: "Something went wrong on the server." }, 500); }
    }
    if (url.pathname === "/api/tweets") {
      try { return await trophies(env, url); }
      catch (e) { return json({ error: "Something went wrong on the server." }, 500); }
    }
    if (url.pathname === "/api/oath") {
      try { return await oath(request, env); }
      catch (e) { return json({ error: "Something went wrong on the server." }, 500); }
    }
    if (url.pathname === "/api/day") {
      try { return await dayReport(request, env, url); }
      catch (e) { return page("Error", "<h1>Something went wrong</h1><p>" + esc(String(e && e.message || e)) + "</p>"); }
    }
    if (url.pathname === "/api/trumpet") {
      try { return await trumpet(request, env); }
      catch (e) { return json({ error: "Something went wrong on the server." }, 500); }
    }
    if (url.pathname === "/api/messages") {
      try { return await handle(request, env, url); }
      catch (e) { return json({ error: "Something went wrong on the server." }, 500); }
    }
    return env.ASSETS.fetch(request);
  },
};
