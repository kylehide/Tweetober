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
//   /api/lair/stats, /api/lair/ideas    House of 500's lair (tweetober.com/lair); header x-lair-code: LAIR_CODE
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

/* ---------- The Lair: House of 500's secret common room (tweetober.com/lair) ----------
   Every /api/lair/* call needs the house password (secret LAIR_CODE) in the x-lair-code header.
   Tweet counts come from twitterapi.io, not the Ledger:
   - today is topped up with only the tweets posted since the last look, at most every LAIR_MINUTES (default 30),
     and the like counts on today's leading tweets are refreshed at the same time;
   - each finished day is read once more in full shortly after midnight, so its like counts settle.
   Scans run in small chunks; the page keeps asking until a scan is finished. */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

const DAY_MS = 864e5, OCT1 = Date.UTC(2026, 9, 1, 4);   // midnight Oct 1, New York (EDT lasts all October)
const dayStart = (d) => OCT1 + (d - 1) * DAY_MS;
const blankDay = () => ({ users: {}, top: [], ids: [], n: { tweet: 0, quote: 0, reply: 0, retweet: 0 }, newest: 0 });
const TOP_KEEP = 40;
const trimTop = (top) => { top.sort((a, b) => b[2] - a[2] || b[3] - a[3]); if (top.length > TOP_KEEP) top.length = TOP_KEEP; return top; };
// one chunk of a scan: up to `pages` pages of the list, folded into the working copy `w`
async function scanChunk(env, w, since, until, cursorIn, pages) {
  const seen = new Set(w.ids); let cursor = cursorIn;
  for (let i = 0; i < pages; i++) {
    const u = new URL("https://api.twitterapi.io/twitter/list/tweets");
    u.searchParams.set("listId", env.LIST_ID || DEFAULT_LIST); u.searchParams.set("includeReplies", "true");
    u.searchParams.set("sinceTime", String(Math.floor(since / 1000))); u.searchParams.set("untilTime", String(Math.ceil(until / 1000)));
    if (cursor) u.searchParams.set("cursor", cursor);
    const r = await fetch(u, { headers: { "X-API-Key": env.TWITTERAPI_KEY } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(data.tweets)) throw new Error("twitterapi.io: " + (data.message || data.msg || r.status));
    let older = false;
    for (const t of data.tweets) {
      const created = when(t.createdAt), id = String(t.id || "");
      if (created && created < since) older = true;
      if (!id || seen.has(id) || created < since || created >= until) continue;
      seen.add(id); w.ids.push(id); w.newest = Math.max(w.newest || 0, created);
      const user = String(t.author?.userName || "");
      const kind = (t.retweeted_tweet || t.retweetedTweet || /^RT @/.test(t.text || "")) ? "retweet"
        : (t.isReply && String(t.inReplyToUsername || "").toLowerCase() !== user.toLowerCase()) ? "reply"
        : (t.quoted_tweet || t.quotedTweet) ? "quote" : "tweet";
      w.n[kind]++;
      const p = w.users[user] ||= [0, 0, 0, 0];   // counted, likes on counted, replies, retweets
      if (kind === "reply") p[2]++; else if (kind === "retweet") p[3]++; else {
        p[0]++; p[1] += t.likeCount | 0;
        w.top.push([user, id, t.likeCount | 0, t.retweetCount | 0, String(t.text || "").slice(0, 200), created]);
        if (w.top.length > TOP_KEEP * 2) trimTop(w.top);
      }
    }
    cursor = data.has_next_page && data.next_cursor && data.tweets.length && !older ? data.next_cursor : "";
    if (!cursor) return { done: true, cursor: "" };
  }
  return { done: false, cursor };
}
// fresh like counts for a day's leading tweets (one cheap call)
async function refreshLikes(env, w) {
  const ids = w.top.slice(0, TOP_KEEP).map(t => t[1]); if (!ids.length) return;
  try {
    const u = new URL("https://api.twitterapi.io/twitter/tweets"); u.searchParams.set("tweet_ids", ids.join(","));
    const r = await fetch(u, { headers: { "X-API-Key": env.TWITTERAPI_KEY } });
    const data = await r.json().catch(() => ({}));
    const got = new Map((data.tweets || []).map(t => [String(t.id), t]));
    for (const t of w.top) {
      const f = got.get(t[1]); if (!f) continue;
      const likes = f.likeCount | 0, diff = likes - t[2];
      if (diff && w.users[t[0]]) w.users[t[0]][1] += diff;
      t[2] = likes; t[3] = f.retweetCount | 0;
    }
    trimTop(w.top);
  } catch {}
}
function lairAuth(request, env) {
  if (!env.LAIR_CODE) return json({ error: "The lair isn't set up yet: add a LAIR_CODE secret to the Worker." }, 503);
  const code = String(request.headers.get("x-lair-code") || "").trim().toLowerCase();
  if (code !== String(env.LAIR_CODE).trim().toLowerCase()) return json({ error: "That is not the word, stranger." }, 403);
  return null;
}
async function lairTables(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS lair_days (day INTEGER PRIMARY KEY, data TEXT NOT NULL, scan TEXT, mode TEXT NOT NULL DEFAULT '', cursor TEXT, since INTEGER NOT NULL DEFAULT 0, upto INTEGER NOT NULL DEFAULT 0, final INTEGER NOT NULL DEFAULT 0, scanned INTEGER NOT NULL DEFAULT 0, lock INTEGER NOT NULL DEFAULT 0)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS lair_cache (k TEXT PRIMARY KEY, body TEXT NOT NULL, fetched INTEGER NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS lair_ideas (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, who TEXT)").run();
}
// do at most one chunk of scanning work; returns true if more work is waiting
async function lairWork(env, now, today) {
  const ttl = Math.max(10, Number(env.LAIR_MINUTES) || 30) * 60000;
  const rows = Object.fromEntries(((await env.DB.prepare("SELECT day, mode, final, scanned, lock FROM lair_days").all()).results || []).map(r => [r.day, r]));
  let job = null, kind = "";
  for (let d = 1; d <= today && !job; d++) {
    const r = rows[d], ended = now >= dayStart(d) + DAY_MS;
    if (r && r.mode) { job = d; kind = "continue"; }
    else if (ended && !(r && r.final)) { job = d; kind = "final"; }
    else if (!ended && (!r || now - r.scanned > ttl)) { job = d; kind = "inc"; }
  }
  if (!job) return false;
  // claim it, so two visitors don't pay for the same pages
  await env.DB.prepare("INSERT INTO lair_days (day, data) VALUES (?, ?) ON CONFLICT(day) DO NOTHING").bind(job, JSON.stringify(blankDay())).run();
  const claim = await env.DB.prepare("UPDATE lair_days SET lock = ? WHERE day = ? AND lock < ?").bind(now + 30000, job, now).run();
  if (!claim.meta.changes) return true;   // someone else is on it
  const r = await env.DB.prepare("SELECT * FROM lair_days WHERE day = ?").bind(job).first();
  let w, since, upto, cursor = "", mode;
  if (kind === "continue") { w = JSON.parse(r.scan || r.data); since = r.since; upto = r.upto; cursor = r.cursor || ""; mode = r.mode; }
  else if (kind === "final") { w = blankDay(); since = dayStart(job); upto = dayStart(job) + DAY_MS; mode = "final"; }
  else { w = JSON.parse(r.data); since = w.newest ? Math.max(dayStart(job), w.newest - 120000) : dayStart(job); upto = now; mode = "inc"; }
  try {
    const res = await scanChunk(env, w, since, upto, cursor, 20);
    if (res.done) {
      if (mode === "inc") await refreshLikes(env, w);
      trimTop(w.top);
      const final = mode === "final" ? 1 : 0;
      await env.DB.prepare("UPDATE lair_days SET data = ?, scan = NULL, mode = '', cursor = '', final = ?, scanned = ?, lock = 0 WHERE day = ?")
        .bind(JSON.stringify(w), final, now, job).run();
    } else {
      await env.DB.prepare("UPDATE lair_days SET scan = ?, mode = ?, cursor = ?, since = ?, upto = ?, lock = 0 WHERE day = ?")
        .bind(JSON.stringify(w), mode, res.cursor, since, upto, job).run();
    }
  } catch (e) {
    await env.DB.prepare("UPDATE lair_days SET lock = 0 WHERE day = ?").bind(job).run();
    throw e;
  }
  return true;
}
async function lairStats(request, env) {
  const now = Date.now();
  const today = Math.max(1, Math.min(31, Math.floor((now - OCT1) / DAY_MS) + 1));
  let busy = false, problem = "";
  if (now >= OCT1 && now < dayStart(31) + 2 * DAY_MS) {
    try { busy = await lairWork(env, now, today); } catch (e) { problem = String(e.message || e).slice(0, 200); }
  }
  const rows = ((await env.DB.prepare("SELECT day, data, final, scanned FROM lair_days WHERE day <= ? ORDER BY day").bind(today).all()).results || []);
  const days = Object.fromEntries(rows.map(r => [r.day, JSON.parse(r.data)]));
  const houses = await ledgerHouses(env), houseOf = (u) => houses[String(u).toLowerCase()] || "";
  const sum = (list) => {
    const out = { "333": [0, 0, 0], "500": [0, 0, 0], "": [0, 0, 0] }, users = {};   // counted, likes, people
    for (const d of list) for (const [u, p] of Object.entries(d.users)) { const x = users[u] ||= [0, 0]; x[0] += p[0]; x[1] += p[1]; }
    for (const [u, x] of Object.entries(users)) { if (!x[0]) continue; const h = out[houseOf(u)]; h[0] += x[0]; h[1] += x[1]; h[2]++; }
    return { houses: out, users };
  };
  const t = days[today] ? sum([days[today]]) : sum([]);
  const m = sum(Object.values(days));
  const tweet = (x) => ({ user: x[0], id: x[1], likes: x[2], rts: x[3], text: x[4], created: x[5], house: houseOf(x[0]) });
  const allTop = [].concat(...Object.values(days).map(d => d.top)).sort((a, b) => b[2] - a[2] || b[3] - a[3]);
  const top20 = allTop.slice(0, 20).map(tweet);
  // Minion of the Day: yesterday's most prolific minion, plus the minion with yesterday's most-liked tweet
  let mvp = null;
  const y = days[today - 1];
  if (y) {
    const minions = Object.entries(y.users).filter(([u, p]) => houseOf(u) === "500" && p[0] > 0).sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1]);
    const best = y.top.filter(x => houseOf(x[0]) === "500").sort((a, b) => b[2] - a[2])[0];
    mvp = { day: today - 1, user: minions[0] ? minions[0][0] : "", tweets: minions[0] ? minions[0][1][0] : 0, likes: minions[0] ? minions[0][1][1] : 0, best: best ? tweet(best) : null };
  }
  // Intel on 333, today
  const td = days[today] || blankDay();
  const theirs = Object.entries(td.users).filter(([u, p]) => houseOf(u) === "333" && p[0] > 0).sort((a, b) => b[1][0] - a[1][0]);
  const theirBest = td.top.filter(x => houseOf(x[0]) === "333").sort((a, b) => b[2] - a[2])[0];
  const intel = { carriers: theirs.slice(0, 3).map(([u, p]) => ({ user: u, tweets: p[0] })), best: theirBest ? tweet(theirBest) : null, posting: theirs.length };
  // quote-tweet bait: today's best tweets from anyone (and the last few hours of yesterday if today is young)
  const bait = [...td.top, ...(y && now - dayStart(today) < 6 * 3600e3 ? y.top : [])].sort((a, b) => b[2] - a[2]).slice(0, 6).map(tweet);
  const minionCount = Object.values(houses).filter(h => h === "500").length;
  const todayRow = rows.find(r => r.day === today);
  return json({ today, now, scannedAt: todayRow ? todayRow.scanned : 0, busy, problem,
    todayHouses: t.houses, monthHouses: m.houses, top20, mvp, intel, bait, minionCount,
    ledgerSize: Object.keys(houses).length, refreshMinutes: Math.max(10, Number(env.LAIR_MINUTES) || 30) });
}
async function lairCached(env, k, maxAgeMs, load) {
  const row = await env.DB.prepare("SELECT body, fetched FROM lair_cache WHERE k = ?").bind(k).first();
  if (row && Date.now() - row.fetched < maxAgeMs) return JSON.parse(row.body);
  try {
    const fresh = await load();
    await env.DB.prepare("INSERT INTO lair_cache (k, body, fetched) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET body = excluded.body, fetched = excluded.fetched").bind(k, JSON.stringify(fresh), Date.now()).run();
    return fresh;
  } catch { return row ? JSON.parse(row.body) : []; }
}
async function lairIdeas(request, env) {
  if (request.method === "POST") {
    let input; try { input = await request.json(); } catch { return json({ error: "That couldn't be read." }, 400); }
    const name = clean(input.name, MAX_NAME).replace(/^@/, ""), body = clean(input.body, 200);
    if (!name || !body) return json({ error: "Add your name and an idea." }, 400);
    const id = await who(request), now = Date.now();
    const last = await env.DB.prepare("SELECT created FROM lair_ideas WHERE who = ? ORDER BY created DESC LIMIT 1").bind(id).first();
    if (last && now - last.created < 15000) return json({ error: "Patience, minion. Try again in a few seconds." }, 429);
    const row = await env.DB.prepare("INSERT INTO lair_ideas (name, body, created, who) VALUES (?, ?, ?, ?) RETURNING id, name, body, created").bind(name, body, now, id).first();
    return json({ idea: row }, 201);
  }
  // Trending on Twitter (refreshed every LAIR_TRENDS_HOURS, default 2)
  const trendHours = Math.max(1, Number(env.LAIR_TRENDS_HOURS) || 2);
  const trends = env.TWITTERAPI_KEY ? await lairCached(env, "trends3", trendHours * 3600e3, async () => {
    const u = new URL("https://api.twitterapi.io/twitter/trends"); u.searchParams.set("woeid", env.TRENDS_WOEID || "23424977"); u.searchParams.set("count", "30");
    const r = await fetch(u, { headers: { "X-API-Key": env.TWITTERAPI_KEY } });
    const data = await r.json(); if (!Array.isArray(data.trends)) throw new Error("no trends");
    const list = data.trends.map(x => x.trend || x).map(x => ({ name: String(x.name || ""), query: String(x.target?.query || x.query || x.name || ""), meta: String(x.meta_description || "") })).filter(x => x.name).slice(0, 20);
    return list;
  }) : [];
  // Wikipedia's daily feed: In the news, On this day, Most read (free; refreshed every 3 hours)
  const ny = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const ymd = `${ny.getFullYear()}/${String(ny.getMonth() + 1).padStart(2, "0")}/${String(ny.getDate()).padStart(2, "0")}`;
  const wiki = await lairCached(env, "wiki:" + ymd, 3 * 3600e3, async () => {
    const r = await fetch(`${env.WIKI_BASE || "https://en.wikipedia.org/api/rest_v1/feed/featured/"}${ymd}`, { headers: { "user-agent": "TweetoberLair/1.0 (https://tweetober.com)", accept: "application/json" } });
    if (!r.ok) throw new Error("wikipedia " + r.status);
    const d = await r.json();
    const strip = (h) => String(h || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();
    const page = (p) => p ? { title: String(p.normalizedtitle || p.titles?.normalized || p.title || ""), link: String(p.content_urls?.desktop?.page || ""), blurb: String(p.description || "") } : null;
    return {
      news: (d.news || []).slice(0, 8).map(n => ({ text: strip(n.story), page: page((n.links || [])[0]) })).filter(n => n.text),
      onthisday: (d.onthisday || []).slice(0, 12).map(e => ({ year: e.year, text: strip(e.text), page: page((e.pages || [])[0]) })).filter(e => e.text),
      mostread: ((d.mostread || {}).articles || []).filter(a => !/^(Main_Page|Special:)/.test(a.title || "")).slice(0, 8).map(a => ({ ...page(a), extract: strip(a.extract).slice(0, 220), views: a.views | 0 })),
    };
  });
  const ideas = (await env.DB.prepare("SELECT id, name, body, created FROM lair_ideas ORDER BY id DESC LIMIT 60").all()).results || [];
  return json({ trends, wiki: wiki && !Array.isArray(wiki) ? wiki : { news: [], onthisday: [], mostread: [] }, ideas });
}
async function lair(request, env, url) {
  const denied = lairAuth(request, env); if (denied) return denied;
  if (!env.DB) return json({ error: "No database." }, 503);
  await lairTables(env.DB);
  if (url.pathname === "/api/lair/stats") {
    if (!env.TWITTERAPI_KEY) return json({ error: "TWITTERAPI_KEY is missing." }, 503);
    return lairStats(request, env);
  }
  if (url.pathname === "/api/lair/ideas") return lairIdeas(request, env);
  if (url.pathname === "/api/lair/check") return json({ ok: true });
  return json({ error: "Not found." }, 404);
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
    if (url.pathname.startsWith("/api/lair/")) {
      try { return await lair(request, env, url); }
      catch (e) { return json({ error: "Something went wrong in the lair.", detail: String(e && e.message || e).slice(0, 200) }, 500); }
    }
    if (url.pathname === "/api/day") return Response.redirect(new URL("/lair/", url), 302);
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
