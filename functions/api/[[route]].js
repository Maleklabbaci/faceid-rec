// FaceID Platform — Cloudflare Pages Functions API (JSON) backed by D1.
//
// Architecture: the kiosk computes 128-d face descriptors in the browser (face-api.js,
// a port of the dlib ResNet used by the desktop app) and matches them locally against
// the organization's enrolled descriptors. This Worker only stores data and applies the
// sector rules (expiry, duplicates, one meal per day, lateness), so it fits the free plan.

const SECTORS = {
  fitness: { label: "Salles de sport & fitness", short: "Sport", person: "membre", people: "membres", access: "Abonnement", entry: "Passage", entries: "Passages", manual: "Passage manuel", rule: null, pitch: "Fini les cartes prêtées aux amis : le membre entre avec son visage." },
  office: { label: "PME & bureaux", short: "Bureau", person: "employé", people: "employés", access: "Contrat", entry: "Pointage", entries: "Pointages", manual: "Pointage manuel", rule: "attendance", pitch: "Pointage quotidien automatique, calcul des retards, zéro triche entre collègues." },
  coworking: { label: "Coworking & centres de formation", short: "Coworking", person: "client", people: "clients", access: "Accès payé", entry: "Entrée", entries: "Entrées", manual: "Entrée manuelle", rule: null, pitch: "Accès selon le temps payé et nombre exact de personnes présentes." },
  canteen: { label: "Cantines & écoles privées", short: "Cantine", person: "inscrit", people: "inscrits", access: "Inscription", entry: "Repas", entries: "Repas", manual: "Repas manuel", rule: "one_per_day", pitch: "Un repas par personne et par jour, présences instantanées." },
};
const TIMEZONES = ["Africa/Algiers", "Africa/Casablanca", "Africa/Tunis", "Africa/Cairo", "Africa/Lagos", "Europe/Paris", "Asia/Dubai", "UTC"];
const DUPLICATE_WINDOW_MS = 60_000;
const SESSION_DAYS = 30;
const DEVICE_DAYS = 365;          // a kiosk stays paired for a year; revocation is instant
const PAIRING_TTL_SECONDS = 600;   // a pairing code lives 10 minutes and is single-use
const PAIRING_MAX_PENDING = 5;
const PAIRING_MAX_ATTEMPTS = 8;
// Codes are read aloud and typed on a phone: no I/O/0/1, 32 symbols.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEVICE_KINDS = {
  kiosk: "Kiosque d'entrée",
  phone: "Téléphone",
  tablet: "Tablette",
  desk: "Poste d'accueil",
  box: "Boîtier / caméra sur site",
};
const PBKDF2_ITERATIONS = 8000; // kept small for the free plan's CPU budget; combined with a server-side pepper (HMAC)
const DUMMY_HASH = "v1$8000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const TABLES = [
  "CREATE TABLE IF NOT EXISTS organizations(id INTEGER PRIMARY KEY, name TEXT NOT NULL, sector TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Africa/Algiers', work_start TEXT NOT NULL DEFAULT '08:30', late_tolerance INTEGER NOT NULL DEFAULT 10, created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS members(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', subscription_end TEXT NOT NULL, descriptor TEXT, consent_at TEXT)",
  "CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, member_id INTEGER NOT NULL, actor_id INTEGER NOT NULL, created_at TEXT NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'granted', local_date TEXT NOT NULL, local_time TEXT NOT NULL, late INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS pairings(code TEXT PRIMARY KEY, org_id INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'kiosk', created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS devices(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'kiosk', token_hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT)",
];
const INDEXES = [
  "CREATE INDEX IF NOT EXISTS members_org ON members(org_id)",
  "CREATE INDEX IF NOT EXISTS entries_org_day ON entries(org_id, local_date)",
  "CREATE INDEX IF NOT EXISTS entries_member ON entries(org_id, member_id, created_at)",
  "CREATE INDEX IF NOT EXISTS devices_org ON devices(org_id, revoked_at)",
  "CREATE INDEX IF NOT EXISTS pairings_org ON pairings(org_id, expires_at)",
];
// Pages projects are sometimes connected to a D1 database that was initialized by an
// older version of the app. CREATE TABLE IF NOT EXISTS does not add new columns, and an
// index referring to one of those columns then makes every API call fail. Keep additive,
// data-preserving migrations here so binding an existing database is safe.
const MIGRATIONS = {
  organizations: {
    timezone: "TEXT NOT NULL DEFAULT 'Africa/Algiers'",
    work_start: "TEXT NOT NULL DEFAULT '08:30'",
    late_tolerance: "INTEGER NOT NULL DEFAULT 10",
    created_at: "TEXT NOT NULL DEFAULT ''",
  },
  members: {
    email: "TEXT NOT NULL DEFAULT ''",
    subscription_end: "TEXT NOT NULL DEFAULT ''",
    descriptor: "TEXT",
    consent_at: "TEXT",
  },
  entries: {
    device_id: "INTEGER",
    status: "TEXT NOT NULL DEFAULT 'granted'",
    local_date: "TEXT NOT NULL DEFAULT ''",
    local_time: "TEXT NOT NULL DEFAULT ''",
    late: "INTEGER NOT NULL DEFAULT 0",
  },
};

// ---------------------------------------------------------------------------
// The D1 binding
// ---------------------------------------------------------------------------
const BINDING_HELP =
  "Dans Cloudflare Pages → votre projet → Settings → Bindings : supprimez la variable « DB » existante, " +
  "puis « Add → D1 database » avec le nom de variable exactement DB, pointant vers la base faceid. " +
  "Redéployez ensuite (Deployments → ⋯ → Retry deployment) : les liaisons sont figées à chaque déploiement.";

function describeBinding(value) {
  if (typeof value === "string") return "une variable texte — les valeurs de Settings → Variables doivent être des secrets/vars, pas la base";
  if (value && typeof value.list === "function" && typeof value.get === "function") return "un namespace KV";
  if (value && typeof value.idFromName === "function") return "un Durable Object";
  if (value && typeof value.fetch === "function") return "une liaison de service (un autre worker)";
  if (value && typeof value.get === "function") return "un bucket R2";
  return `un ${value === null ? "null" : typeof value} sans méthode prepare()`;
}

function inspectBinding(env) {
  const db = env && env.DB;
  if (!db) return { ready: false, kind: "missing", problem: `Base D1 non liée sous le nom « DB ». ${BINDING_HELP}` };
  if (typeof db.prepare === "function") return { ready: true, kind: "d1", db };
  // A truthy env.DB that is not a database is the classic misbinding: it used to explode with
  // "env.DB.prepare is not a function" in the invocation log and a bare 500 for every visitor.
  return { ready: false, kind: "wrong-type", problem: `La liaison « DB » existe mais ce n'est pas une base D1 (${describeBinding(db)}). ${BINDING_HELP}` };
}

let schemaReady = null;
async function initializeSchema(env) {
  // Create tables first. Index statements must only be prepared after migrations because
  // D1 validates referenced columns while preparing a statement.
  await env.DB.batch(TABLES.map((sql) => env.DB.prepare(sql)));
  for (const [table, columns] of Object.entries(MIGRATIONS)) {
    const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    const existing = new Set((info.results || []).map((column) => column.name));
    for (const [column, definition] of Object.entries(columns)) {
      if (!existing.has(column)) await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
  }
  await env.DB.batch(INDEXES.map((sql) => env.DB.prepare(sql)));
}

function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = initializeSchema(env).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
}

const enc = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const b64url = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

async function sha256hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function derive(password, salt, iterations, pepper) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  const hmacKey = await crypto.subtle.importKey("raw", enc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, bits));
}

function pepperOf(env) { return env.PEPPER || "faceid-default-pepper-set-the-PEPPER-secret"; }

async function hashPassword(password, env) {
  const salt = randomBytes(16);
  const mac = await derive(password, salt, PBKDF2_ITERATIONS, pepperOf(env));
  return `v1$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(mac)}`;
}

async function verifyPassword(password, stored, env) {
  const [version, iterations, salt, mac] = (stored || "").split("$");
  if (version !== "v1") return false;
  const computed = await derive(password, unb64(salt), Number(iterations), pepperOf(env));
  const expected = unb64(mac);
  if (computed.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed[i] ^ expected[i];
  return diff === 0;
}

function cookieValue(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// Browsers only accept a `Secure` cookie inside a secure context. A kiosk opened through
// plain HTTP on a LAN address (http://192.168.1.20:8788) is not one, so a forced `Secure`
// flag makes the browser silently drop the session: signup answers 200, then /app bounces
// back to /login forever. Loopback and HTTPS stay secure.
function isSecureRequest(request) {
  if ((request.headers.get("x-forwarded-proto") || "").split(",")[0].trim() === "https") return true;
  const url = new URL(request.url);
  if (url.protocol === "https:") return true;
  return /^(localhost$|127\.|::1$|\[::1\]$)/.test(url.hostname);
}

function cookieOptions(env, request) {
  return { secure: isSecureRequest(request), embed: Boolean(env && env.EMBED_PREVIEW) };
}

function authCookie(name, token, maxAge, { secure = true, embed = false } = {}) {
  // EMBED_PREVIEW=1 (local demos inside a third-party iframe only) relaxes SameSite; never set it in production.
  const parts = [`${name}=${token}`, "Path=/", "HttpOnly"];
  if (embed && secure) parts.push("SameSite=None", "Secure"); // SameSite=None is refused without Secure
  else { if (secure) parts.push("Secure"); parts.push("SameSite=Lax"); }
  parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

const sessionCookie = (token, maxAge, options) => authCookie("sid", token, maxAge, options);

function localParts(timezone, date = new Date()) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const hour = p.hour === "24" ? "00" : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}`, minutes: Number(hour) * 60 + Number(p.minute) };
}

function shiftDay(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400, "Date invalide.");
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) fail(400, "Date invalide.");
  return value;
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "local";
}

// Behind Cloudflare every visitor has a distinct IP. Without it — `wrangler pages dev`,
// the test suite, a demo on a kiosk LAN — everyone shares one bucket, so the budgets are
// widened: a demo must not lock itself out of the signup page after five accounts.
function limitsFor(request) {
  return request.headers.get("CF-Connecting-IP")
    ? { signup: 5, loginAccount: 10, loginIp: 60 }
    : { signup: 60, loginAccount: 100, loginIp: 600 };
}

async function limited(env, key, max, windowSeconds) {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT count, reset_at FROM limits WHERE key=?").bind(key).first();
  if (!row || row.reset_at < now) {
    await env.DB.prepare("INSERT OR REPLACE INTO limits(key,count,reset_at) VALUES(?,?,?)").bind(key, 1, now + windowSeconds * 1000).run();
    return;
  }
  if (row.count >= max) fail(429, "Trop de tentatives. Réessayez plus tard.");
  await env.DB.prepare("UPDATE limits SET count=count+1 WHERE key=?").bind(key).run();
}

function assertSameOrigin(request, { allowNoOrigin = false } = {}) {
  // Fetch-metadata based CSRF protection for all state-changing calls.
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") fail(403, "Requête inter-site refusée.");
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) fail(403, "Origine inattendue.");
  // allowNoOrigin is for non-browser clients (a box, curl, a camera relay): they send neither
  // Origin nor Sec-Fetch-Site. A cross-site *browser* request is still refused above.
  if (!site && !origin && !allowNoOrigin) fail(403, "Requête sans origine refusée.");
}

function hasBearerToken(request) {
  return /^Bearer\s+\S+/i.test(request.headers.get("Authorization") || "");
}

async function readJson(request) {
  try { return (await request.json()) || {}; } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Auth & tenant context
// ---------------------------------------------------------------------------
async function currentUser(env, request) {
  const token = cookieValue(request, "sid");
  if (!token) return null;
  const id = await sha256hex(token);
  const row = await env.DB.prepare(
    `SELECT users.id AS user_id, users.email, organizations.id AS org_id, organizations.name AS org_name, organizations.sector,
            organizations.timezone, organizations.work_start, organizations.late_tolerance
     FROM sessions JOIN users ON users.id=sessions.user_id JOIN organizations ON organizations.id=users.org_id
     WHERE sessions.id=? AND sessions.expires_at>?`,
  ).bind(id, Date.now()).first();
  if (!row) return null;
  if (!SECTORS[row.sector]) row.sector = { education: "canteen", enterprise: "office", leisure: "fitness" }[row.sector] || "fitness";
  row.sectorConfig = SECTORS[row.sector];
  return row;
}

async function startSession(env, userId, request) {
  const token = b64url(randomBytes(32));
  const id = await sha256hex(token);
  const maxAge = SESSION_DAYS * 86400;
  await env.DB.prepare("INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)").bind(id, userId, Date.now() + maxAge * 1000).run();
  return sessionCookie(token, maxAge, cookieOptions(env, request));
}

async function memberOf(env, user, memberId) {
  const row = await env.DB.prepare("SELECT * FROM members WHERE id=? AND org_id=?").bind(memberId, user.org_id).first();
  if (!row) fail(404, "Introuvable dans votre espace.");
  return row;
}

// ---------------------------------------------------------------------------
// Access rules (shared by manual entries and facial recognition)
// ---------------------------------------------------------------------------
async function record(env, user, member, method) {
  const sector = user.sectorConfig;
  const local = localParts(user.timezone);
  const result = { granted: member.subscription_end >= local.date, duplicate: false, already: false, late: false, late_minutes: 0, local_time: local.time };
  let status = "refused";
  if (result.granted) {
    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
    const dup = await env.DB.prepare("SELECT 1 AS x FROM entries WHERE org_id=? AND member_id=? AND status='granted' AND created_at>=?").bind(user.org_id, member.id, since).first();
    if (dup) { result.duplicate = true; return result; }
    const today = await env.DB.prepare("SELECT 1 AS x FROM entries WHERE org_id=? AND member_id=? AND status='granted' AND local_date=?").bind(user.org_id, member.id, local.date).first();
    const firstToday = !today;
    if (sector.rule === "one_per_day" && !firstToday) { result.already = true; return result; }
    if (sector.rule === "attendance" && firstToday) {
      const [h, m] = (user.work_start || "08:30").split(":").map(Number);
      const limit = h * 60 + m + (Number(user.late_tolerance) || 0);
      if (local.minutes > limit) { result.late = true; result.late_minutes = local.minutes - limit; }
    }
    status = "granted";
  }
  await env.DB.prepare("INSERT INTO entries(org_id,member_id,actor_id,created_at,method,status,local_date,local_time,late,device_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .bind(user.org_id, member.id, user.user_id || 0, new Date().toISOString(), method, status, local.date, local.time, result.late ? 1 : 0, user.device_id || null).run();
  return result;
}

function entryMessage(sector, name, result) {
  if (result.duplicate) return `${name} : déjà enregistré(e) il y a moins d'une minute.`;
  if (sector.rule === "attendance") return `${name} : pointage enregistré à ${result.local_time}` + (result.late ? ` — retard de ${result.late_minutes} min` : "") + ".";
  if (sector.rule === "one_per_day") return `${name} : repas enregistré. Bon appétit !`;
  return `${name} : accès autorisé.`;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
async function signup(env, request) {
  assertSameOrigin(request);
  const body = await readJson(request);
  const name = String(body.company || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const sector = body.sector;
  if (!name || name.length > 100 || !email.includes("@") || email.length > 254 || password.length < 12 || password.length > 256 || !SECTORS[sector]) {
    // Rejected before the rate limiter is consumed: a typo must not lock a legitimate
    // customer out of the signup page for the next hour.
    fail(400, "Vérifiez les champs. Le mot de passe doit contenir 12 à 256 caractères.");
  }
  await limited(env, `signup:${clientIp(request)}`, limitsFor(request).signup, 3600);
  const exists = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
  if (exists) fail(409, "Impossible de créer ce compte avec ces informations. Essayez de vous connecter.");
  const org = await env.DB.prepare("INSERT INTO organizations(name,sector,created_at) VALUES(?,?,?)").bind(name, sector, new Date().toISOString()).run();
  let user;
  try {
    user = await env.DB.prepare("INSERT INTO users(org_id,email,password) VALUES(?,?,?)").bind(org.meta.last_row_id, email, await hashPassword(password, env)).run();
  } catch (err) {
    // D1 has no cross-request transaction: undo the organization instead of leaving an
    // orphan company behind when the unique email races another signup.
    await env.DB.prepare("DELETE FROM organizations WHERE id=?").bind(org.meta.last_row_id).run().catch(() => {});
    if (/UNIQUE constraint failed: users\.email/.test(String(err && err.message))) fail(409, "Impossible de créer ce compte avec ces informations. Essayez de vous connecter.");
    throw err;
  }
  const cookie = await startSession(env, user.meta.last_row_id, request);
  return json({ ok: true, redirect: "/app" }, 200, { "Set-Cookie": cookie });
}

async function login(env, request) {
  assertSameOrigin(request);
  const body = await readJson(request);
  const email = String(body.email || "").trim().toLowerCase();
  const limits = limitsFor(request);
  // Two buckets instead of one: guessing a known account is throttled per account *and* per
  // visitor, so colleagues sharing one NAT address cannot lock each other out — 10 logins in
  // 5 minutes is nothing for a hundred employees on Monday morning. Spraying many accounts
  // from one address stays throttled by the second bucket.
  await limited(env, `login:acct:${await sha256hex(email || "-")}:${clientIp(request)}`, limits.loginAccount, 300);
  await limited(env, `login:ip:${clientIp(request)}`, limits.loginIp, 300);
  const row = await env.DB.prepare("SELECT id, password FROM users WHERE email=?").bind(email).first();
  const password = String(body.password || "");
  let ok = false;
  if (row) ok = await verifyPassword(password, row.password, env);
  else await verifyPassword(password, DUMMY_HASH, env); // same work whether or not the account exists
  if (!ok) fail(401, "Email ou mot de passe incorrect.");
  const cookie = await startSession(env, row.id, request);
  return json({ ok: true, redirect: "/app" }, 200, { "Set-Cookie": cookie });
}

async function logout(env, request) {
  assertSameOrigin(request);
  const token = cookieValue(request, "sid");
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(await sha256hex(token)).run();
  return json({ ok: true, redirect: "/" }, 200, { "Set-Cookie": sessionCookie("", 0, cookieOptions(env, request)) });
}

async function state(env, user, params = new URLSearchParams()) {
  const org = user.org_id;
  const sector = user.sectorConfig;
  const today = localParts(user.timezone).date;
  // Deux réglages de lecture pour l'interface : la fenêtre du graphique/période, et le pointeur
  // du direct (« since ») qui ne renvoie que les passages parus depuis la dernière fois — c'est
  // ce qui permet à l'espace de notifier une entrée fraîche sans rappeler tout le journal.
  const days = Math.min(90, Math.max(1, Number(params.get("days")) || 7));
  const since = Math.max(0, Number(params.get("since")) || 0);
  const from = shiftDay(today, 1 - days);
  const logsSql = `SELECT entries.id, entries.method, entries.status, entries.local_date, entries.local_time, entries.late, entries.device_id, members.name,
                          devices.name AS device_name
                   FROM entries JOIN members ON members.id=entries.member_id
                   LEFT JOIN devices ON devices.id=entries.device_id
                   WHERE entries.org_id=?${since ? " AND entries.id>?" : ""} ORDER BY entries.id DESC LIMIT ${since ? 200 : 30}`;
  const logsStmt = env.DB.prepare(logsSql);
  const [membersRes, logsRes, countsRes, lateRes, periodRes, devicesRes, headRes] = await env.DB.batch([
    env.DB.prepare(`SELECT m.id, m.name, m.email, m.subscription_end, m.consent_at IS NOT NULL AS enrolled,
                           (SELECT MAX(e.local_time) FROM entries e WHERE e.org_id=m.org_id AND e.member_id=m.id AND e.status='granted' AND e.local_date=?) AS last_today
                    FROM members m WHERE m.org_id=? ORDER BY m.id DESC`).bind(today, org),
    since ? logsStmt.bind(org, since) : logsStmt.bind(org),
    env.DB.prepare("SELECT status, COUNT(*) AS n, COUNT(DISTINCT member_id) AS people FROM entries WHERE org_id=? AND local_date=? GROUP BY status").bind(org, today),
    env.DB.prepare("SELECT COUNT(*) AS n FROM entries WHERE org_id=? AND local_date=? AND late=1").bind(org, today),
    env.DB.prepare("SELECT local_date, status, COUNT(*) AS n, COUNT(DISTINCT member_id) AS people FROM entries WHERE org_id=? AND local_date>=? GROUP BY local_date, status").bind(org, from),
    env.DB.prepare("SELECT id, name, last_seen_at, revoked_at FROM devices WHERE org_id=?").bind(org),
    env.DB.prepare("SELECT MAX(id) AS head FROM entries WHERE org_id=?").bind(org),
  ]);
  const members = membersRes.results;
  // La même phrase que celle du kiosque : l'écran de l'entreprise raconte le passage, il ne le
  // numérote pas. Un refus reste sans message : c'est la règle de l'espace qui a protégé l'entrée,
  // pas une panne du poste. C'est ce texte qui sert de corps à la notification ; le retard, lui,
  // reste un badge (la colonne le dit mieux qu'une phrase répétée).
  const logs = (logsRes.results || []).map((l) => ({ ...l, late: Boolean(l.late), message: l.status === "granted" ? entryMessage(sector, l.name, { local_time: l.local_time, late: false, late_minutes: 0 }) : "" }));
  const counts = Object.fromEntries(countsRes.results.map((r) => [r.status, r]));
  const active = members.filter((m) => m.subscription_end >= today).length;
  const entriesToday = counts.granted?.n || 0;
  const presentToday = counts.granted?.people || 0;
  const refusedToday = counts.refused?.n || 0;
  const lateToday = lateRes.results[0]?.n || 0;
  const period = { from, to: today, days, granted: 0, refused: 0, people: 0, late: 0, byDay: {} };
  for (const row of periodRes.results || []) {
    period.byDay[row.local_date] = (period.byDay[row.local_date] || 0) + (row.status === "granted" ? row.n : 0);
    if (row.status === "granted") { period.granted += row.n; period.people = Math.max(period.people, row.people); }
    else period.refused += row.n;
    if (row.status === "granted" && row.local_date === today) period.late = lateToday;
  }
  const deviceRows = devicesRes.results || [];
  const now = Date.now();
  const devicesInfo = {
    count: deviceRows.filter((d) => !d.revoked_at).length,
    online: deviceRows.filter((d) => d.last_seen_at && now - Date.parse(d.last_seen_at) < 120000).length,
  };
  let kpis;
  if (sector.rule === "attendance") kpis = [["Employés", members.length, ""], ["Présents aujourd'hui", presentToday, "ok"], ["Absents", Math.max(active - presentToday, 0), "warn"], ["Retards aujourd'hui", lateToday, "warn"], ["Pointages aujourd'hui", entriesToday, ""]];
  else if (sector.rule === "one_per_day") kpis = [["Inscrits", members.length, ""], ["Repas servis aujourd'hui", entriesToday, "ok"], ["Inscriptions actives", active, ""], ["Expirées", members.length - active, "warn"], ["Refus aujourd'hui", refusedToday, "warn"]];
  else if (user.sector === "coworking") kpis = [["Clients", members.length, ""], ["Présents aujourd'hui", presentToday, "ok"], ["Accès actifs", active, ""], ["Expirés", members.length - active, "warn"], ["Refus aujourd'hui", refusedToday, "warn"]];
  else kpis = [["Membres", members.length, ""], ["Abonnements actifs", active, "ok"], ["Expirés", members.length - active, "warn"], ["Passages aujourd'hui", entriesToday, ""], ["Refus aujourd'hui", refusedToday, "warn"]];

  let attendance = [];
  if (sector.rule === "attendance") {
    const { results } = await env.DB.prepare("SELECT member_id, MIN(local_time) AS arrival, MAX(late) AS late FROM entries WHERE org_id=? AND status='granted' AND local_date=? GROUP BY member_id").bind(org, today).all();
    const first = Object.fromEntries(results.map((r) => [r.member_id, r]));
    attendance = members.filter((m) => m.subscription_end >= today)
      .map((m) => ({ name: m.name, arrival: first[m.id]?.arrival || null, late: Boolean(first[m.id]?.late) }))
      .sort((a, b) => (a.arrival === null) - (b.arrival === null) || (a.arrival || "").localeCompare(b.arrival || "") || a.name.localeCompare(b.name));
  }
  const chartDays = Array.from({ length: days }, (_, i) => shiftDay(today, i - (days - 1)));
  const chart = chartDays.map((d) => ({ day: d.slice(5), count: period.byDay[d] || 0 }));
  return json({
    user: { email: user.email },
    org: { name: user.org_name, sector: user.sector, timezone: user.timezone, work_start: user.work_start, late_tolerance: user.late_tolerance },
    sector, sectors: SECTORS, timezones: TIMEZONES, today, members, logs, kpis, attendance, chart,
    period, devices: devicesInfo, head: headRes.results[0]?.head || 0, since,
  });
}

async function addMember(env, user, request) {
  const body = await readJson(request);
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim();
  if (!name || name.length > 100 || email.length > 254) fail(400, "Nom requis (100 caractères maximum).");
  const end = validDate(body.subscription_end);
  const res = await env.DB.prepare("INSERT INTO members(org_id,name,email,subscription_end) VALUES(?,?,?,?)").bind(user.org_id, name, email, end).run();
  return json({ ok: true, id: res.meta.last_row_id, message: `${name} ajouté(e) à votre espace.` });
}

async function renew(env, user, member, request) {
  const end = validDate((await readJson(request)).subscription_end);
  await env.DB.prepare("UPDATE members SET subscription_end=? WHERE id=? AND org_id=?").bind(end, member.id, user.org_id).run();
  return json({ ok: true, message: `${user.sectorConfig.access} mis à jour.` });
}

async function remove(env, user, member) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM entries WHERE org_id=? AND member_id=?").bind(user.org_id, member.id),
    env.DB.prepare("DELETE FROM members WHERE id=? AND org_id=?").bind(member.id, user.org_id),
  ]);
  return json({ ok: true, message: "Fiche, données biométriques et historique associé supprimés." });
}

async function manualEntry(env, user, member) {
  const sector = user.sectorConfig;
  if (member.subscription_end < localParts(user.timezone).date) fail(409, `${sector.access} expiré(e) : refus.`);
  const result = await record(env, user, member, "Manuel");
  if (result.already) fail(409, `${member.name} : déjà enregistré(e) aujourd'hui (règle « un ${sector.entry.toLowerCase()} par jour »).`, { status: "already" });
  const message = result.duplicate ? `${member.name} : déjà enregistré(e) il y a moins d'une minute.` : `${sector.entry} enregistré pour ${member.name} à ${result.local_time}` + (result.late ? ` (retard de ${result.late_minutes} min)` : "") + ".";
  return json({ ok: true, message });
}

function validDescriptor(value) {
  if (!Array.isArray(value) || value.length !== 128 || !value.every((x) => typeof x === "number" && Number.isFinite(x))) fail(400, "Empreinte faciale invalide.");
  return value.map((x) => Math.round(x * 10000) / 10000);
}

async function enroll(env, user, member, request) {
  const body = await readJson(request);
  if (body.consent !== true) fail(400, "Consentement explicite requis.");
  const descriptor = validDescriptor(body.descriptor);
  await env.DB.prepare("UPDATE members SET descriptor=?, consent_at=? WHERE id=? AND org_id=?").bind(JSON.stringify(descriptor), new Date().toISOString(), member.id, user.org_id).run();
  return json({ ok: true, status: "ok", message: `Visage de ${member.name} enregistré avec consentement.` });
}

async function revoke(env, user, member) {
  await env.DB.prepare("UPDATE members SET descriptor=NULL, consent_at=NULL WHERE id=? AND org_id=?").bind(member.id, user.org_id).run();
  return json({ ok: true, message: "Données biométriques effacées." });
}

/**
 * Journal filtré par période, sans le reste de l'état : c'est ce que l'interface télécharge quand
 * on clique sur « Exporter en CSV » (et ce qu'un client tiers peut lire pour son propre tableur).
 */
async function journal(env, user, params) {
  const days = Math.min(365, Math.max(1, Number(params.get("days")) || 30));
  const today = localParts(user.timezone).date;
  const from = shiftDay(today, 1 - days);
  const { results } = await env.DB.prepare(
    `SELECT entries.id, entries.member_id, members.name, members.email, entries.method, entries.status,
            entries.local_date, entries.local_time, entries.late, devices.name AS device_name
     FROM entries JOIN members ON members.id=entries.member_id
     LEFT JOIN devices ON devices.id=entries.device_id
     WHERE entries.org_id=? AND entries.local_date>=?
     ORDER BY entries.local_date DESC, entries.id DESC LIMIT 5000`
  ).bind(user.org_id, from).all();
  return json({ ok: true, from, to: today, days, count: results.length, rows: results.map((r) => ({ ...r, late: Boolean(r.late) })) });
}

async function descriptors(env, user) {
  const { results } = await env.DB.prepare("SELECT id, name, subscription_end, descriptor FROM members WHERE org_id=? AND descriptor IS NOT NULL AND consent_at IS NOT NULL").bind(user.org_id).all();
  return json({ members: results.map((r) => ({ id: r.id, name: r.name, subscription_end: r.subscription_end, d: JSON.parse(r.descriptor) })) });
}

async function recognized(env, user, request) {
  const body = await readJson(request);
  const member = await memberOf(env, user, Number(body.member_id));
  if (!member.consent_at) fail(409, "Ce membre n'a pas de visage enregistré.");
  const sector = user.sectorConfig;
  const result = await record(env, user, member, "Facial");
  const base = { name: member.name, local_time: result.local_time, confidence: typeof body.distance === "number" ? Math.round((1 - body.distance) * 100) / 100 : null };
  if (!result.granted) return json({ ...base, status: "expired", message: `${member.name} : ${sector.access.toLowerCase()} expiré(e) le ${member.subscription_end}, accès refusé.` }, 403);
  if (result.already) return json({ ...base, status: "already", message: `${member.name} : ${sector.entry.toLowerCase()} déjà enregistré aujourd'hui.` }, 409);
  return json({ ...base, status: "granted", late: result.late, message: entryMessage(sector, member.name, result) });
}

async function settings(env, user, request) {
  const body = await readJson(request);
  const name = String(body.company || "").trim();
  const sector = body.sector;
  const timezone = body.timezone || "Africa/Algiers";
  const workStart = String(body.work_start || "08:30");
  const tolerance = Number(body.late_tolerance ?? 10);
  if (!name || name.length > 100 || !SECTORS[sector] || !TIMEZONES.includes(timezone)) fail(400, "Paramètres invalides.");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(workStart) || !Number.isInteger(tolerance) || tolerance < 0 || tolerance > 240) fail(400, "Heure ou tolérance invalide.");
  await env.DB.prepare("UPDATE organizations SET name=?, sector=?, timezone=?, work_start=?, late_tolerance=? WHERE id=?").bind(name, sector, timezone, workStart, tolerance, user.org_id).run();
  return json({ ok: true, message: "Votre espace a été personnalisé." });
}

// ---------------------------------------------------------------------------
// Linked devices: an admin mints a short code, the other device redeems it and
// gets a token. A linked device can *only* run the kiosk: recognise a face and
// log a passage. No member list, no subscription, no settings, no journal export.
// ---------------------------------------------------------------------------

function pairingCode() {
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

// Codes get typed on a phone: spaces and case are the user's business, not ours.
const normalizeCode = (value) => String(value == null ? "" : value).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
const deviceKind = (value) => (DEVICE_KINDS[value] ? value : "kiosk");
const deviceName = (value) => {
  const name = String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, 60);
  return name;
};

/** Admin screen: what is linked right now, and which codes are still waiting. */
async function devices(env, user) {
  const now = Date.now();
  const [list, pending] = await env.DB.batch([
    env.DB.prepare("SELECT id, name, kind, created_at, last_seen_at, revoked_at FROM devices WHERE org_id=? ORDER BY id DESC").bind(user.org_id),
    env.DB.prepare("SELECT code, name, kind, expires_at FROM pairings WHERE org_id=? AND expires_at>? ORDER BY expires_at DESC").bind(user.org_id, now),
  ]);
  return json({
    ok: true,
    devices: (list.results || []).map((d) => ({ ...d, kind_label: DEVICE_KINDS[d.kind] || DEVICE_KINDS.kiosk, online: Boolean(d.last_seen_at) && Date.now() - Date.parse(d.last_seen_at) < 120000 })),
    pairings: (pending.results || []).map((p) => ({ ...p, kind_label: DEVICE_KINDS[p.kind] || DEVICE_KINDS.kiosk, seconds_left: Math.max(0, Math.round((p.expires_at - now) / 1000)) })),
  });
}

/** Admin action: open a door for 10 minutes. */
async function createPairing(env, user, request) {
  const body = await readJson(request);
  const name = deviceName(body.name);
  if (name.length < 2) fail(400, "Donnez un nom d'au moins 2 caractères à l'appareil (ex. « Borne entrée »).");
  const kind = deviceKind(body.kind);
  const now = Date.now();
  const pending = await env.DB.prepare("SELECT code FROM pairings WHERE org_id=? AND expires_at>?").bind(user.org_id, now).all();
  if ((pending.results || []).length >= PAIRING_MAX_PENDING) fail(409, "Trop de codes en attente : annulez-en un avant d'en générer un autre.");
  let code = pairingCode();
  for (let i = 0; i < 5; i++) {
    const clash = await env.DB.prepare("SELECT code FROM pairings WHERE code=?").bind(code).first();
    if (!clash) break;
    code = pairingCode();
    if (i === 4) fail(503, "Impossible de trouver un code libre, réessayez.");
  }
  await env.DB.prepare("INSERT INTO pairings(code,org_id,name,kind,created_at,expires_at,attempts) VALUES(?,?,?,?,?,?,0)")
    .bind(code, user.org_id, name, kind, new Date().toISOString(), now + PAIRING_TTL_SECONDS * 1000).run();
  return json({
    ok: true, code, name, kind, kind_label: DEVICE_KINDS[kind],
    link: `/kiosk?pair=${code}`,
    expires_in: PAIRING_TTL_SECONDS,
    message: `Code ${code} prêt : ouvrez le lien sur l'appareil à relier, ou saisissez ce code sur /kiosk.`,
  });
}

async function cancelPairing(env, user, request) {
  const code = normalizeCode((await readJson(request)).code);
  await env.DB.prepare("DELETE FROM pairings WHERE code=? AND org_id=?").bind(code, user.org_id).run();
  return json({ ok: true, message: "Code annulé." });
}

/** Public, unauthenticated: the device redeems its code and comes back with a token. */
async function pair(env, request) {
  // A browser must be on this site; a camera box has no Origin header at all, so that case is
  // allowed through. Nothing here relies on cookies: the single-use code and the IP budget do the work.
  assertSameOrigin(request, { allowNoOrigin: true });
  await limited(env, `pair:${clientIp(request)}`, 15, 300);
  const body = await readJson(request);
  const code = normalizeCode(body.code);
  if (code.length !== 6) fail(400, "Code invalide : 6 caractères, sans espaces.");
  const row = await env.DB.prepare("SELECT * FROM pairings WHERE code=?").bind(code).first();
  if (!row) fail(404, "Ce code n'existe pas. Régénérez-le depuis l'espace de l'entreprise.");
  if (row.expires_at < Date.now()) {
    await env.DB.prepare("DELETE FROM pairings WHERE code=?").bind(code).run();
    fail(410, "Ce code a expiré. Redemandez-en un dans l'espace de l'entreprise.");
  }
  if (row.attempts >= PAIRING_MAX_ATTEMPTS) fail(429, "Trop d'essais avec ce code. Redemandez-en un nouveau.");
  // A code hammered by a stuck client gets burned; a successful redeem deletes the row anyway.
  await env.DB.prepare("UPDATE pairings SET attempts=attempts+1 WHERE code=?").bind(code).run();
  const org = await env.DB.prepare("SELECT id, name, sector, timezone FROM organizations WHERE id=?").bind(row.org_id).first();
  if (!org) fail(410, "Cet espace n'existe plus.");
  const token = b64url(randomBytes(32));
  const hash = await sha256hex(token);
  let device;
  try {
    [device] = await env.DB.batch([
      env.DB.prepare("INSERT INTO devices(org_id,name,kind,token_hash,created_at) VALUES(?,?,?,?,?)").bind(row.org_id, row.name, row.kind, hash, new Date().toISOString()),
      env.DB.prepare("DELETE FROM pairings WHERE code=?").bind(code),
    ]);
  } catch (err) {
    if (/UNIQUE/i.test(String(err && err.message))) fail(409, "Jeton déjà émis, régénérez un code.");
    throw err;
  }
  const name = deviceName(body.name);
  if (name) await env.DB.prepare("UPDATE devices SET name=? WHERE id=?").bind(name, device.meta.last_row_id).run();
  const kind = body.kind ? deviceKind(body.kind) : row.kind;
  if (kind !== row.kind) await env.DB.prepare("UPDATE devices SET kind=? WHERE id=?").bind(kind, device.meta.last_row_id).run();
  return json({
    ok: true,
    token,
    device: { id: device.meta.last_row_id, name: name || row.name, kind, kind_label: DEVICE_KINDS[kind] },
    org: { name: org.name, sector: SECTORS[org.sector] ? org.sector : "fitness" },
    message: `${name || row.name} est relié à ${org.name}.`,
  }, 200, { "Set-Cookie": authCookie("did", token, DEVICE_DAYS * 86400, cookieOptions(env, request)) });
}

/** Who is calling: a paired device (cookie `did` or `Authorization: Bearer`). */
async function currentDevice(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.match(/^Bearer\s+(\S+)$/i);
  const token = bearer ? bearer[1] : cookieValue(request, "did");
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT devices.id AS device_id, devices.name AS device_name, devices.kind, devices.org_id,
            organizations.name AS org_name, organizations.sector, organizations.timezone,
            organizations.work_start, organizations.late_tolerance
     FROM devices JOIN organizations ON organizations.id=devices.org_id
     WHERE devices.token_hash=? AND devices.revoked_at IS NULL`
  ).bind(await sha256hex(token)).first();
  if (!row) return null;
  if (!SECTORS[row.sector]) row.sector = "fitness";
  row.sectorConfig = SECTORS[row.sector];
  row.user_id = 0;              // no human behind a kiosk: the row is its own author
  row.email = row.device_name;
  return row;
}

/** What a kiosk needs to run: its identity, the sector rules, today, and the last passages. */
async function deviceState(env, device) {
  const local = localParts(device.timezone);
  const [counts, logs] = await env.DB.batch([
    env.DB.prepare("SELECT status, COUNT(*) AS n, COUNT(DISTINCT member_id) AS people FROM entries WHERE org_id=? AND local_date=? GROUP BY status").bind(device.org_id, local.date),
    env.DB.prepare(
      `SELECT entries.id, entries.method, entries.status, entries.local_date, entries.local_time, entries.late,
              members.name, devices.name AS device_name
       FROM entries JOIN members ON members.id=entries.member_id
       LEFT JOIN devices ON devices.id=entries.device_id
       WHERE entries.org_id=? ORDER BY entries.id DESC LIMIT 12`
    ).bind(device.org_id),
    env.DB.prepare("UPDATE devices SET last_seen_at=? WHERE id=?").bind(new Date().toISOString(), device.device_id),
  ]);
  const byStatus = {};
  let people = 0;
  for (const row of counts.results || []) { byStatus[row.status] = row.n; if (row.status === "granted") people = row.people; }
  return json({
    ok: true, user: null,
    device: { id: device.device_id, name: device.device_name, kind: device.kind, kind_label: DEVICE_KINDS[device.kind] },
    org: { name: device.org_name, sector: device.sector },
    sector: device.sectorConfig,
    today: local.date,
    granted: byStatus.granted || 0,
    refused: byStatus.refused || 0,
    people,
    logs: (logs.results || []).map((e) => ({ ...e, late: Boolean(e.late), message: entryMessage(device.sectorConfig, e.name, { granted: e.status === "granted", late: Boolean(e.late), late_minutes: 0 }) })),
  });
}

/** Admin action: rename or revoke. Revocation is immediate — the token stops resolving. */
async function updateDevice(env, user, deviceId, request, action) {
  if (action === "revoke") {
    const done = await env.DB.prepare("UPDATE devices SET revoked_at=? WHERE id=? AND org_id=?").bind(new Date().toISOString(), deviceId, user.org_id).run();
    if (!done.meta.changes) fail(404, "Appareil introuvable dans votre espace.");
    return json({ ok: true, message: "Appareil révoqué. Son jeton ne fonctionne plus, sur aucun de ses kiosques." });
  }
  const name = deviceName((await readJson(request)).name);
  if (!name) fail(400, "Nom trop court.");
  const done = await env.DB.prepare("UPDATE devices SET name=? WHERE id=? AND org_id=?").bind(name, deviceId, user.org_id).run();
  if (!done.meta.changes) fail(404, "Appareil introuvable dans votre espace.");
  return json({ ok: true, name, message: "Nom mis à jour." });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const method = request.method;
  try {
    const binding = inspectBinding(env);
    // /api/healthz stays reachable whatever happens: it is how a broken project explains itself.
    if (path === "healthz" && method === "GET") {
      if (!binding.ready) return json({ status: "degraded", db: false, detail: binding.kind, message: binding.problem, pepper: Boolean(env.PEPPER) }, 503);
      try {
        await env.DB.prepare("SELECT 1").first();
      } catch (err) {
        return json({ status: "degraded", db: false, detail: "requête refusée par D1", message: String((err && err.message) || err), pepper: Boolean(env.PEPPER) }, 503);
      }
      return json({ status: "ok", db: true, pepper: Boolean(env.PEPPER) });
    }
    // Short for the person at the counter, full instructions in `hint` for the administrator
    // (and for `wrangler tail`, where this used to surface as a bare TypeError).
    if (!binding.ready) fail(503, "Le service est en cours de configuration : base de données non reliée. Réessayez dans un moment.", { hint: binding.problem });
    await ensureSchema(env);

    if (path === "sectors" && method === "GET") return json({ sectors: SECTORS, timezones: TIMEZONES });
    // A device redeems its code here. No CSRF assertion: the caller may be a box on the
    // shop floor with no Origin header at all — the single-use code and the rate limit are the guard.
    if (path === "pair" && method === "POST") return await pair(env, request);

    // ---- a linked device: kiosk rights only, forever -----------------------
    if (path === "device" || path.startsWith("device/")) {
      const device = await currentDevice(env, request);
      if (!device) fail(401, "Appareil non relié. Saisissez le code affiché dans l'espace de l'entreprise.");
      const action = path === "device" ? "state" : path.slice(7);
      if (action === "state" && method === "GET") return await deviceState(env, device);
      if (action === "descriptors" && method === "GET") return await descriptors(env, device);
      if (method !== "GET" && !hasBearerToken(request)) assertSameOrigin(request); // cookies need CSRF cover; Bearer calls don't
      if (action === "recognized" && method === "POST") return await recognized(env, device, request);
      if (action === "unpair" && method === "POST") {
        // Forget this browser only: the token itself stays valid until an administrator revokes it.
        return json({ ok: true, message: "Cet appareil n'est plus relié au kiosque." }, 200, { "Set-Cookie": authCookie("did", "", 0, cookieOptions(env, request)) });
      }
      if (action === "entry" && method === "POST") {
        const body = await readJson(request);
        return await manualEntry(env, device, await memberOf(env, device, Number(body.member_id)));
      }
      fail(404, "Route inconnue.");
    }
    if (path === "signup" && method === "POST") return await signup(env, request);
    if (path === "login" && method === "POST") return await login(env, request);
    if (path === "logout" && method === "POST") return await logout(env, request);

    const user = await currentUser(env, request);
    if (path === "me" && method === "GET") return json({ user: user ? { email: user.email, org: user.org_name, sector: user.sector } : null });
    if (!user) fail(401, "Connexion requise.");
    if (method !== "GET") assertSameOrigin(request);

    if (path === "state" && method === "GET") return await state(env, user, url.searchParams);
    if (path === "descriptors" && method === "GET") return await descriptors(env, user);
    if (path === "journal" && method === "GET") return await journal(env, user, url.searchParams);
    if (path === "members" && method === "POST") return await addMember(env, user, request);
    if (path === "recognized" && method === "POST") return await recognized(env, user, request);
    if (path === "settings" && method === "POST") return await settings(env, user, request);

    if (path === "devices" && method === "GET") return await devices(env, user);
    if (path === "devices/pairing" && method === "POST") return await createPairing(env, user, request);
    if (path === "devices/pairing/cancel" && method === "POST") return await cancelPairing(env, user, request);
    if (path === "devices/revoke-all" && method === "POST") {
      const done = await env.DB.prepare("UPDATE devices SET revoked_at=? WHERE org_id=? AND revoked_at IS NULL").bind(new Date().toISOString(), user.org_id).run();
      return json({ ok: true, revoked: done.meta.changes || 0, message: done.meta.changes ? `${done.meta.changes} kiosque(s) déconnecté(s) : plus aucun jeton de votre espace ne fonctionne.` : "Aucun appareil à déconnecter." });
    }
    const dev = path.match(/^devices\/(\d+)\/(revoke|rename)$/);
    if (dev && method === "POST") return await updateDevice(env, user, Number(dev[1]), request, dev[2]);

    const m = path.match(/^members\/(\d+)\/(renew|delete|entry|enroll|revoke)$/);
    if (m && method === "POST") {
      const member = await memberOf(env, user, Number(m[1]));
      switch (m[2]) {
        case "renew": return await renew(env, user, member, request);
        case "delete": return await remove(env, user, member);
        case "entry": return await manualEntry(env, user, member);
        case "enroll": return await enroll(env, user, member, request);
        case "revoke": return await revoke(env, user, member);
      }
    }
    fail(404, "Route inconnue.");
  } catch (err) {
    if (err instanceof HttpError) return json({ ok: false, status: err.extra.status || "error", message: err.message, ...err.extra }, err.status);
    console.error(err);
    return json({ ok: false, status: "error", message: "Erreur interne." }, 500);
  }
}
