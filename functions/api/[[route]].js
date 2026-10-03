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
const PBKDF2_ITERATIONS = 8000; // kept small for the free plan's CPU budget; combined with a server-side pepper (HMAC)
const DUMMY_HASH = "v1$8000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS organizations(id INTEGER PRIMARY KEY, name TEXT NOT NULL, sector TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Africa/Algiers', work_start TEXT NOT NULL DEFAULT '08:30', late_tolerance INTEGER NOT NULL DEFAULT 10, created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS members(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', subscription_end TEXT NOT NULL, descriptor TEXT, consent_at TEXT)",
  "CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, member_id INTEGER NOT NULL, actor_id INTEGER NOT NULL, created_at TEXT NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'granted', local_date TEXT NOT NULL, local_time TEXT NOT NULL, late INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS members_org ON members(org_id)",
  "CREATE INDEX IF NOT EXISTS entries_org_day ON entries(org_id, local_date)",
  "CREATE INDEX IF NOT EXISTS entries_member ON entries(org_id, member_id, created_at)",
];

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).catch((err) => { schemaReady = null; throw err; });
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

function sessionCookie(token, maxAge) {
  return `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

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

function assertSameOrigin(request) {
  // Fetch-metadata based CSRF protection for all state-changing calls.
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") fail(403, "Requête inter-site refusée.");
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) fail(403, "Origine inattendue.");
  if (!site && !origin) fail(403, "Requête sans origine refusée.");
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

async function startSession(env, userId) {
  const token = b64url(randomBytes(32));
  const id = await sha256hex(token);
  const maxAge = SESSION_DAYS * 86400;
  await env.DB.prepare("INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)").bind(id, userId, Date.now() + maxAge * 1000).run();
  return sessionCookie(token, maxAge);
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
  await env.DB.prepare("INSERT INTO entries(org_id,member_id,actor_id,created_at,method,status,local_date,local_time,late) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(user.org_id, member.id, user.user_id, new Date().toISOString(), method, status, local.date, local.time, result.late ? 1 : 0).run();
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
  await limited(env, `signup:${clientIp(request)}`, 5, 3600);
  const body = await readJson(request);
  const name = String(body.company || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const sector = body.sector;
  if (!name || name.length > 100 || !email.includes("@") || email.length > 254 || password.length < 12 || password.length > 256 || !SECTORS[sector]) {
    fail(400, "Vérifiez les champs. Le mot de passe doit contenir 12 à 256 caractères.");
  }
  const exists = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
  if (exists) fail(409, "Impossible de créer ce compte avec ces informations. Essayez de vous connecter.");
  const org = await env.DB.prepare("INSERT INTO organizations(name,sector,created_at) VALUES(?,?,?)").bind(name, sector, new Date().toISOString()).run();
  const user = await env.DB.prepare("INSERT INTO users(org_id,email,password) VALUES(?,?,?)").bind(org.meta.last_row_id, email, await hashPassword(password, env)).run();
  const cookie = await startSession(env, user.meta.last_row_id);
  return json({ ok: true, redirect: "/app" }, 200, { "Set-Cookie": cookie });
}

async function login(env, request) {
  assertSameOrigin(request);
  await limited(env, `login:${clientIp(request)}`, 10, 300);
  const body = await readJson(request);
  const email = String(body.email || "").trim().toLowerCase();
  const row = await env.DB.prepare("SELECT id, password FROM users WHERE email=?").bind(email).first();
  const password = String(body.password || "");
  let ok = false;
  if (row) ok = await verifyPassword(password, row.password, env);
  else await verifyPassword(password, DUMMY_HASH, env); // same work whether or not the account exists
  if (!ok) fail(401, "Email ou mot de passe incorrect.");
  const cookie = await startSession(env, row.id);
  return json({ ok: true, redirect: "/app" }, 200, { "Set-Cookie": cookie });
}

async function logout(env, request) {
  assertSameOrigin(request);
  const token = cookieValue(request, "sid");
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(await sha256hex(token)).run();
  return json({ ok: true, redirect: "/" }, 200, { "Set-Cookie": sessionCookie("", 0) });
}

async function state(env, user) {
  const org = user.org_id;
  const sector = user.sectorConfig;
  const today = localParts(user.timezone).date;
  const [membersRes, logsRes, countsRes, lateRes] = await env.DB.batch([
    env.DB.prepare("SELECT id,name,email,subscription_end,consent_at IS NOT NULL AS enrolled FROM members WHERE org_id=? ORDER BY id DESC").bind(org),
    env.DB.prepare("SELECT entries.id, entries.method, entries.status, entries.local_date, entries.local_time, entries.late, members.name FROM entries JOIN members ON members.id=entries.member_id WHERE entries.org_id=? ORDER BY entries.id DESC LIMIT 30").bind(org),
    env.DB.prepare("SELECT status, COUNT(*) AS n, COUNT(DISTINCT member_id) AS people FROM entries WHERE org_id=? AND local_date=? GROUP BY status").bind(org, today),
    env.DB.prepare("SELECT COUNT(*) AS n FROM entries WHERE org_id=? AND local_date=? AND late=1").bind(org, today),
  ]);
  const members = membersRes.results;
  const logs = logsRes.results;
  const counts = Object.fromEntries(countsRes.results.map((r) => [r.status, r]));
  const active = members.filter((m) => m.subscription_end >= today).length;
  const entriesToday = counts.granted?.n || 0;
  const presentToday = counts.granted?.people || 0;
  const refusedToday = counts.refused?.n || 0;
  const lateToday = lateRes.results[0]?.n || 0;
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
  const days = Array.from({ length: 7 }, (_, i) => shiftDay(today, i - 6));
  const { results: perDay } = await env.DB.prepare("SELECT local_date, COUNT(*) AS n FROM entries WHERE org_id=? AND status='granted' AND local_date>=? GROUP BY local_date").bind(org, days[0]).all();
  const byDay = Object.fromEntries(perDay.map((r) => [r.local_date, r.n]));
  const chart = days.map((d) => ({ day: d.slice(5), count: byDay[d] || 0 }));
  return json({
    user: { email: user.email },
    org: { name: user.org_name, sector: user.sector, timezone: user.timezone, work_start: user.work_start, late_tolerance: user.late_tolerance },
    sector, sectors: SECTORS, timezones: TIMEZONES, today, members, logs, kpis, attendance, chart,
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
// Router
// ---------------------------------------------------------------------------
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const method = request.method;
  try {
    if (!env.DB) fail(503, "Base D1 non liée : ajoutez la liaison « DB » dans Cloudflare Pages → Settings → Bindings.");
    await ensureSchema(env);

    if (path === "healthz" && method === "GET") {
      await env.DB.prepare("SELECT 1").first();
      return json({ status: "ok", db: true, pepper: Boolean(env.PEPPER) });
    }
    if (path === "sectors" && method === "GET") return json({ sectors: SECTORS, timezones: TIMEZONES });
    if (path === "signup" && method === "POST") return await signup(env, request);
    if (path === "login" && method === "POST") return await login(env, request);
    if (path === "logout" && method === "POST") return await logout(env, request);

    const user = await currentUser(env, request);
    if (path === "me" && method === "GET") return json({ user: user ? { email: user.email, org: user.org_name, sector: user.sector } : null });
    if (!user) fail(401, "Connexion requise.");
    if (method !== "GET") assertSameOrigin(request);

    if (path === "state" && method === "GET") return await state(env, user);
    if (path === "descriptors" && method === "GET") return await descriptors(env, user);
    if (path === "members" && method === "POST") return await addMember(env, user, request);
    if (path === "recognized" && method === "POST") return await recognized(env, user, request);
    if (path === "settings" && method === "POST") return await settings(env, user, request);

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
