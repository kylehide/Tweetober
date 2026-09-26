// Tweetober 5 - serves the site, plus a tiny message board API for The Hall.
//
//   GET    /api/messages            -> latest 60 messages (oldest first)
//   GET    /api/messages?after=ID   -> only messages newer than ID
//   POST   /api/messages            -> { name, color, body, code }  (code must match HALL_CODE)
//   DELETE /api/messages?id=ID      -> remove one (header  x-admin-key: ADMIN_KEY)
//   GET    /api/trumpet              -> { count }   how many times the trumpet has been sounded
//   POST   /api/trumpet              -> { count }   sound it once more
//
// Settings (Cloudflare dashboard -> this Worker -> Settings -> Variables and Secrets):
//   HALL_CODE  secret  optional. Leave unset and anyone can post. Set it (e.g. hinge) to require a password.
//   ADMIN_KEY  secret  any long random string; lets you delete messages.

const COLORS = ["#F26F96", "#E6E4E0", "#F2D272", "#B99CFF", "#8CC8FF", "#8FE3B6", "#FF9D5C", "#FFB3C7"];
const MAX_NAME = 24, MAX_BODY = 280, COOLDOWN_MS = 8000, PAGE = 60;

let ready = false;
async function ensureTable(db) {
  if (ready) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, who TEXT)"
  ).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS messages_who ON messages (who, created)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)").run();
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
    const name = clean(input.name, MAX_NAME), body = clean(input.body, MAX_BODY);
    const color = COLORS.includes(input.color) ? input.color : COLORS[0];
    if (!name) return json({ error: "Give yourself a name first." }, 400);
    if (!body) return json({ error: "Write something to post." }, 400);
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
