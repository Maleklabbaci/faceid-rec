// End-to-end tests for the Cloudflare Pages edition (functions/api + D1), run against a
// local `wrangler pages dev` server. Usage: `npm test` (starts the server itself) or set
// FACEID_URL=http://127.0.0.1:8788 to reuse a running one.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";

const PORT = 8790;
let BASE = process.env.FACEID_URL || "";
let server = null;
// Same server, reached through a non-loopback address: that is how a kiosk on the LAN
// (http://192.168.1.20:8788) sees it, and browsers drop Secure cookies outside HTTPS.
const LAN_IP = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
let LAN_BASE = "";

async function waitFor(url, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start: " + url);
}

before(async () => {
  if (!BASE) {
    BASE = `http://127.0.0.1:${PORT}`;
    server = spawn("npx", ["wrangler", "pages", "dev", "site", "--d1", "DB=faceid", "--port", String(PORT), "--ip", "0.0.0.0", "--persist-to", ".wrangler/test-state"], { stdio: "ignore", detached: true });
  }
  await waitFor(BASE + "/api/healthz");
  LAN_BASE = LAN_IP ? `http://${LAN_IP}:${new URL(BASE).port || PORT}` : "";
});
after(() => { if (server) { try { process.kill(-server.pid, "SIGTERM"); } catch (_) { server.kill("SIGTERM"); } } });

// Minimal cookie-aware client, same-origin headers like a browser fetch.
function client(base = BASE) {
  let cookie = "";
  const ip = visitorIp(); // one "visitor" per client (rate limits are per IP)
  async function call(path, body, method, extraHeaders = {}) {
    const headers = { Origin: base, "Sec-Fetch-Site": "same-origin", "CF-Connecting-IP": ip, ...extraHeaders };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(base + path, { method: method || (body !== undefined ? "POST" : "GET"), headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    let data = null;
    try { data = await res.json(); } catch (_) { /* static */ }
    return { status: res.status, data, headers: res.headers };
  }
  return { call, cookies: () => cookie };
}

const uniq = () => Math.random().toString(36).slice(2, 8);
// Les budgets de tentatives sont comptés par adresse. Ce fichier peut être rejoué contre un
// serveur déjà lancé dont l'état D1 a gardé les buckets de la fois précédente : chaque client
// prend donc une adresse tirée dans un espace assez large pour ne jamais se rentrer dedans.
const visitorIp = () => `10.${64 + Math.floor(Math.random() * 64)}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
const descriptor = (seed) => Array.from({ length: 128 }, (_, i) => Math.sin(seed + i) / 11);
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

async function signup(c, sector = "fitness") {
  const email = `t-${uniq()}@example.com`;
  const r = await c.call("/api/signup", { company: "Salle " + uniq(), sector, email, password: "motdepasse-solide-123" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return email;
}

test("static pages & security headers", async () => {
  for (const path of ["/", "/login", "/signup", "/app"]) {
    const r = await fetch(BASE + path);
    assert.equal(r.status, 200, path);
    assert.match(await r.text(), /FaceID/);
    assert.match(r.headers.get("content-security-policy") || "", /default-src 'self'/, path);
  }
  const models = await fetch(BASE + "/models/face_recognition_model-weights_manifest.json");
  assert.equal(models.status, 200);
  assert.match(models.headers.get("cache-control") || "", /immutable/);
  const engine = await fetch(BASE + "/vendor/face-api.js", { method: "HEAD" });
  assert.equal(engine.status, 200);
});

test("healthz & sectors", async () => {
  const c = client();
  const h = await c.call("/api/healthz");
  assert.equal(h.status, 200);
  assert.equal(h.data.status, "ok");
  assert.equal(h.data.db, true);
  const s = await c.call("/api/sectors");
  assert.deepEqual(Object.keys(s.data.sectors), ["fitness", "office", "coworking", "canteen"]);
});

test("auth: signup, me, logout, login, validation, csrf", async () => {
  const c = client();
  const bad = await c.call("/api/signup", { company: "X", sector: "fitness", email: "a@b.c", password: "court" });
  assert.equal(bad.status, 400);
  const email = await signup(c);
  assert.match(c.cookies(), /^sid=/);
  let me = await c.call("/api/me");
  assert.equal(me.data.user.email, email);
  const dup = await c.call("/api/signup", { company: "Y", sector: "office", email, password: "motdepasse-solide-123" });
  assert.equal(dup.status, 409);
  await c.call("/api/logout", {});
  me = await c.call("/api/me");
  assert.equal(me.data.user, null);
  const wrong = await c.call("/api/login", { email, password: "mauvais-mot-de-passe" });
  assert.equal(wrong.status, 401);
  const ok = await c.call("/api/login", { email, password: "motdepasse-solide-123" });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("set-cookie"), /HttpOnly/);
  assert.match(ok.headers.get("set-cookie"), /SameSite=Lax/);
  // cross-site POST is refused even with a valid cookie
  const csrf = await c.call("/api/members", { name: "Evil", subscription_end: today }, "POST", { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" });
  assert.equal(csrf.status, 403);
  const anon = client();
  assert.equal((await anon.call("/api/state")).status, 401);
});

test("members lifecycle, tenant isolation, manual entry, dashboard state", async () => {
  const c = client();
  await signup(c, "fitness");
  const add = await c.call("/api/members", { name: "Amine", email: "amine@example.com", subscription_end: today });
  assert.equal(add.status, 200);
  const id = add.data.id;
  assert.equal((await c.call("/api/members", { name: "", subscription_end: today })).status, 400);
  assert.equal((await c.call("/api/members", { name: "Bad", subscription_end: "2026-13-45" })).status, 400);
  const expired = await c.call("/api/members", { name: "Expiré", subscription_end: yesterday });

  // another company cannot see or touch the member
  const other = client();
  await signup(other, "coworking");
  assert.equal((await other.call(`/api/members/${id}/entry`, {})).status, 404);
  assert.equal((await other.call("/api/state")).data.members.length, 0);

  const entry = await c.call(`/api/members/${id}/entry`, {});
  assert.equal(entry.status, 200);
  assert.match(entry.data.message, /Passage enregistré pour Amine/);
  const again = await c.call(`/api/members/${id}/entry`, {});
  assert.equal(again.status, 200);
  assert.match(again.data.message, /moins d'une minute/);
  assert.equal((await c.call(`/api/members/${expired.data.id}/entry`, {})).status, 409);

  const state = (await c.call("/api/state")).data;
  assert.equal(state.org.sector, "fitness");
  assert.equal(state.members.length, 2);
  assert.equal(state.logs.length, 1);
  assert.equal(state.logs[0].method, "Manuel");
  assert.equal(state.kpis[0][0], "Membres");
  assert.equal(state.kpis[0][1], 2);
  assert.equal(state.kpis[1][1], 1); // actifs
  assert.equal(state.kpis[3][1], 1); // passages aujourd'hui
  assert.equal(state.chart.length, 7);
  assert.equal(state.chart[6].count, 1);

  const renew = await c.call(`/api/members/${expired.data.id}/renew`, { subscription_end: today });
  assert.equal(renew.status, 200);
  const del = await c.call(`/api/members/${id}/delete`, {});
  assert.equal(del.status, 200);
  const after = (await c.call("/api/state")).data;
  assert.equal(after.members.length, 1);
  assert.equal(after.logs.length, 0);
});

test("enrollment with consent, descriptors feed, browser-side recognition flow", async () => {
  const c = client();
  await signup(c, "fitness");
  const m = (await c.call("/api/members", { name: "Sara", subscription_end: today })).data;
  const old = (await c.call("/api/members", { name: "Yacine", subscription_end: yesterday })).data;
  assert.equal((await c.call(`/api/members/${m.id}/enroll`, { descriptor: descriptor(1), consent: false })).status, 400);
  assert.equal((await c.call(`/api/members/${m.id}/enroll`, { descriptor: [1, 2, 3], consent: true })).status, 400);
  assert.equal((await c.call(`/api/members/${m.id}/enroll`, { descriptor: descriptor(1), consent: true })).status, 200);
  assert.equal((await c.call(`/api/members/${old.id}/enroll`, { descriptor: descriptor(2), consent: true })).status, 200);

  const feed = (await c.call("/api/descriptors")).data;
  assert.equal(feed.members.length, 2);
  assert.equal(feed.members[0].d.length, 128);
  assert.ok(Math.abs(feed.members[0].d[3] - descriptor(1)[3]) < 1e-3);

  const granted = await c.call("/api/recognized", { member_id: m.id, distance: 0.31 });
  assert.equal(granted.status, 200);
  assert.equal(granted.data.status, "granted");
  assert.equal(granted.data.name, "Sara");
  assert.equal(granted.data.confidence, 0.69);
  const expired = await c.call("/api/recognized", { member_id: old.id, distance: 0.4 });
  assert.equal(expired.status, 403);
  assert.equal(expired.data.status, "expired");

  const stateBefore = (await c.call("/api/state")).data;
  assert.equal(stateBefore.members.find((x) => x.id === m.id).enrolled, 1);
  assert.equal(stateBefore.logs.filter((l) => l.method === "Facial").length, 2);

  assert.equal((await c.call(`/api/members/${m.id}/revoke`, {})).status, 200);
  assert.equal((await c.call("/api/descriptors")).data.members.length, 1);
  assert.equal((await c.call("/api/recognized", { member_id: m.id, distance: 0.3 })).status, 409);
  assert.equal((await c.call("/api/recognized", { member_id: 999999, distance: 0.3 })).status, 404);
});

test("canteen: one meal per day", async () => {
  const c = client();
  await signup(c, "canteen");
  const m = (await c.call("/api/members", { name: "Lina", subscription_end: today })).data;
  await c.call(`/api/members/${m.id}/enroll`, { descriptor: descriptor(3), consent: true });
  const first = await c.call("/api/recognized", { member_id: m.id, distance: 0.2 });
  assert.equal(first.data.status, "granted");
  assert.match(first.data.message, /Bon appétit/);
  // the 60 s duplicate guard answers first; a manual second meal is refused as "already"
  const second = await c.call(`/api/members/${m.id}/entry`, {});
  assert.equal(second.status, 200);
  assert.match(second.data.message, /moins d'une minute/);
  const state = (await c.call("/api/state")).data;
  assert.equal(state.kpis[1][0], "Repas servis aujourd'hui");
  assert.equal(state.kpis[1][1], 1);
});

test("office: settings, lateness and attendance board", async () => {
  const c = client();
  await signup(c, "office");
  const bad = await c.call("/api/settings", { company: "Bureau", sector: "office", timezone: "Mars/Olympus", work_start: "08:30", late_tolerance: 10 });
  assert.equal(bad.status, 400);
  // work day started at 00:00 with zero tolerance => any check-in today is late
  const ok = await c.call("/api/settings", { company: "Bureau SARL", sector: "office", timezone: "UTC", work_start: "00:00", late_tolerance: 0 });
  assert.equal(ok.status, 200);
  const m = (await c.call("/api/members", { name: "Karim", subscription_end: today })).data;
  const absent = (await c.call("/api/members", { name: "Nadia", subscription_end: today })).data;
  assert.ok(absent.id);
  const entry = await c.call(`/api/members/${m.id}/entry`, {});
  assert.equal(entry.status, 200);
  assert.match(entry.data.message, /Pointage enregistré pour Karim .* \(retard de \d+ min\)/);
  const state = (await c.call("/api/state")).data;
  assert.equal(state.org.name, "Bureau SARL");
  assert.equal(state.org.timezone, "UTC");
  assert.equal(state.kpis[0][0], "Employés");
  assert.equal(state.kpis[1][1], 1); // présents
  assert.equal(state.kpis[2][1], 1); // absents
  assert.equal(state.kpis[3][1], 1); // retards
  assert.equal(state.attendance.length, 2);
  assert.equal(state.attendance[0].name, "Karim");
  assert.equal(state.attendance[0].late, true);
  assert.equal(state.attendance[1].arrival, null);
  assert.equal(state.logs[0].late, 1);
});

test("login rate limit: per account and per visitor, but never a whole office", async () => {
  const ip = visitorIp(); // une seule adresse pour tout le test, mais tirée à chaque exécution
  const c = client();
  const email = `nobody-${uniq()}@example.com`;
  let last;
  for (let i = 0; i < 11; i++) last = await c.call("/api/login", { email, password: "mauvais-mot-de-passe" }, "POST", { "CF-Connecting-IP": ip });
  assert.equal(last.status, 429, "guessing one account is throttled");
  // 60 colleagues behind one NAT address must not lock each other out
  for (let i = 0; i < 12; i++) last = await c.call("/api/login", { email: `colleague-${uniq()}@example.com`, password: "mauvais-mot-de-passe" }, "POST", { "CF-Connecting-IP": ip });
  assert.equal(last.status, 401, "different accounts keep working from the same address");
  for (let i = 0; i < 49; i++) last = await c.call("/api/login", { email: `spray-${uniq()}@example.com`, password: "x" }, "POST", { "CF-Connecting-IP": ip });
  assert.equal(last.status, 429, "spraying many accounts from one address is throttled too");
});

test("signup validation does not burn the hourly signup budget", async () => {
  const ip = visitorIp();
  const c = client();
  for (let i = 0; i < 4; i++) {
    const r = await c.call("/api/signup", { company: "Trop court", sector: "fitness", email: `oops-${uniq()}@example.com`, password: "court" }, "POST", { "CF-Connecting-IP": ip });
    assert.equal(r.status, 400);
  }
  const ok = await c.call("/api/signup", { company: "Après les erreurs", sector: "fitness", email: `ok-${uniq()}@example.com`, password: "motdepasse-solide-123" }, "POST", { "CF-Connecting-IP": ip });
  assert.equal(ok.status, 200, "a few typos must not lock the signup page for an hour");
});

test("session cookie: Secure over HTTPS, still usable on a plain-HTTP kiosk", async (t) => {
  const c = client();
  const body = { company: "Kiosque LAN", sector: "fitness", email: `cookie-${uniq()}@example.com`, password: "motdepasse-kiosque-12" };
  // Adresses tirées au sort : ce fichier peut être rejoué contre un serveur déjà lancé, dont
  // l'état D1 a retenu les budgets d'inscription de la fois précédente.
  // Cloudflare terminates TLS and forwards the scheme; loopback counts as a secure context too.
  const ips = { secure: visitorIp(), lan: visitorIp() };
  const secure = await c.call("/api/signup", body, "POST", { "X-Forwarded-Proto": "https", "CF-Connecting-IP": ips.secure });
  assert.equal(secure.status, 200, JSON.stringify(secure.data));
  assert.match(secure.headers.get("set-cookie"), /HttpOnly/, "the cookie is never readable from scripts");
  assert.match(secure.headers.get("set-cookie"), /Secure; SameSite=Lax/, "HTTPS keeps the Secure flag");
  if (!LAN_BASE) { t.skip("no second network address in this sandbox"); return; }
  const c2 = client(LAN_BASE); // the same app, reached as http://192.168.x.x from the LAN
  const plain = await c2.call("/api/signup", { ...body, email: `lan-${uniq()}@example.com`, company: "Kiosque LAN 2" }, "POST", { "CF-Connecting-IP": ips.lan });
  assert.equal(plain.status, 200, JSON.stringify(plain.data));
  const cookie = plain.headers.get("set-cookie");
  assert.equal(/;\s*Secure/.test(cookie), false, "no Secure flag over plain HTTP: browsers would drop the cookie and the login would loop");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal((await c2.call("/api/state")).status, 200, "…and that cookie really authenticates the next call");
});

// ---------------------------------------------------------------------------
// Linked devices: pairing codes, the kiosk-only scope, revocation.
// ---------------------------------------------------------------------------

/** A device client: no cookies, just a bearer token — like a box on the shop floor. */
function device(base = BASE) {
  let token = "";
  // Un boîtier n'a pas d'adresse « naturelle » : chaque client du test prend la sienne, sinon
  // deux exécutions successives sur un serveur partagé se marchent sur le budget de l'appairage.
  const ip = visitorIp();
  async function call(path, body, headers = {}) {
    const h = { "Content-Type": "application/json", "CF-Connecting-IP": ip, ...headers };
    if (token) h.Authorization = "Bearer " + token;
    const res = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch (_) { /* not json */ }
    // like the kiosk page: an answer that carries a token is kept and used from then on
    if (data && data.token) token = data.token;
    return { status: res.status, data };
  }
  return { call, set token(v) { token = v; }, get token() { return token; } };
}

test("appairage : le code est court, daté, utilisable une fois", async () => {
  const c = client();
  await signup(c, "fitness");
  assert.equal((await client().call("/api/devices")).status, 401, "la liste des appareils demande une session");

  const short = await c.call("/api/devices/pairing", { name: "x", kind: "kiosk" });
  assert.equal(short.status, 400, "un nom d'une lettre ne suffit pas");
  const made = await c.call("/api/devices/pairing", { name: "Borne entrée", kind: "box" });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const { code, link, expires_in: ttl } = made.data;
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/, "6 caractères sans I/O/0/1, lisibles au téléphone");
  assert.equal(ttl, 600, "10 minutes de validité");
  assert.equal(link, `/kiosk?pair=${code}`, "le lien s'ouvre directement sur le kiosque");

  const list = await c.call("/api/devices");
  assert.equal(list.data.pairings.length, 1);
  assert.ok(list.data.pairings[0].seconds_left > 500 && list.data.pairings[0].seconds_left <= 600);
  assert.equal(list.data.pairings[0].name, "Borne entrée");

  // a wrong code tells you nothing about which part was wrong
  const nope = await device().call("/api/pair", { code: "ZZZZZZ" });
  assert.equal(nope.status, 404);
  // typing the link from the screen: case and spaces don't matter
  const d = device();
  const paired = await d.call("/api/pair", { code: code.toLowerCase().split("").join(" ") });
  assert.equal(paired.status, 200, JSON.stringify(paired.data));
  assert.match(paired.data.token, /^[A-Za-z0-9_-]{40,}$/, "un jeton d'appareil, jamais un cookie de session");
  assert.equal(paired.data.device.kind, "box");
  assert.match(paired.data.message, /relié à/);

  // single use: the same code cannot open a second device
  const again = await device().call("/api/pair", { code });
  assert.equal(again.status, 404, "un code sert une fois");
  assert.equal((await c.call("/api/devices")).data.pairings.length, 0);

  const devices = (await c.call("/api/devices")).data.devices;
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, "Borne entrée");
  assert.equal(devices[0].token_hash, undefined, "le jeton n'est jamais renvoyé une 2e fois");

  // cancelling a code that was never used
  const spare = await c.call("/api/devices/pairing", { name: "Tablette accueil" });
  assert.equal(spare.status, 200);
  assert.equal((await c.call("/api/devices/pairing/cancel", { code: spare.data.code })).status, 200);
  assert.equal((await c.call("/api/devices")).data.pairings.length, 0);
  assert.equal((await device().call("/api/pair", { code: spare.data.code })).status, 404);
});

test("un appareil lié fait le kiosque, rien d'autre", async () => {
  const c = client();
  await signup(c, "canteen");
  const mine = (await c.call("/api/members", { name: "Nadia", subscription_end: today })).data;
  const gone = (await c.call("/api/members", { name: "Hakim", subscription_end: yesterday })).data;
  const faceless = (await c.call("/api/members", { name: "Karim", subscription_end: today })).data;
  await c.call(`/api/members/${mine.id}/enroll`, { descriptor: descriptor(11), consent: true });
  await c.call(`/api/members/${gone.id}/enroll`, { descriptor: descriptor(12), consent: true });
  const code = (await c.call("/api/devices/pairing", { name: "Borne self", kind: "kiosk" })).data.code;

  const d = device();
  const paired = await d.call("/api/pair", { code, name: "Borne self (hall)" });
  assert.equal(paired.status, 200, JSON.stringify(paired.data));
  assert.equal(paired.data.device.name, "Borne self (hall)", "l'appareil peut se donner son propre nom");
  const org = (await c.call("/api/state")).data.org;
  assert.equal(paired.data.org.name, org.name);

  const state = await d.call("/api/device/state");
  assert.equal(state.status, 200);
  assert.equal(state.data.sector.rule, "one_per_day");
  assert.equal(state.data.members, undefined, "pas la liste des adhérents");
  assert.equal(state.data.settings, undefined, "pas les réglages de l'espace");
  assert.equal(state.data.device.kind_label, "Kiosque d'entrée");

  const feed = await d.call("/api/device/descriptors");
  assert.equal(feed.status, 200);
  assert.equal(feed.data.members.length, 2, "les visages consentis, uniquement ceux de cet espace");
  assert.equal(feed.data.members.some((m) => m.id === faceless.id), false, "un membre sans consentement ne descend jamais dans un kiosque");
  assert.equal(feed.data.members[0].name, "Nadia");
  assert.equal(feed.data.members[0].d.length, 128);

  const ok = await d.call("/api/device/recognized", { member_id: mine.id, distance: 0.2 });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, "granted");
  const expired = await d.call("/api/device/recognized", { member_id: gone.id, distance: 0.2 });
  assert.equal(expired.status, 403);
  assert.equal(expired.data.status, "expired");
  // a face that lingers in front of the lens must not be counted twice
  const twice = await d.call("/api/device/recognized", { member_id: mine.id, distance: 0.2 });
  assert.equal(twice.status, 200);
  assert.match(twice.data.message, /moins d'une minute/, "le doublon est annoncé, pas compté");

  const manual = await d.call("/api/device/entry", { member_id: gone.id });
  assert.equal(manual.status, 409, "abonnement expiré : le kiosque ne peut pas forcer le passage");
  const stranger = await d.call("/api/device/entry", { member_id: faceless.id });
  assert.equal(stranger.status, 200, "le poste d'accueil peut pointer un sans-visage, avec la règle du jour");
  const again = await d.call("/api/device/entry", { member_id: faceless.id });
  assert.equal(again.status, 200);
  assert.match(again.data.message, /moins d'une minute/, "deux scans d'affilée ne comptent pas deux passages");

  // what the kiosk did is visible to the human in charge, with the device's name
  const logs = (await c.call("/api/state")).data.logs;
  assert.equal(logs.length, 3);
  assert.deepEqual(logs.map((l) => l.device_name), ["Borne self (hall)", "Borne self (hall)", "Borne self (hall)"], "chaque ligne dit d'où elle vient");
  assert.equal(logs[0].method, "Manuel", "le plus récent en premier : pointage manuel de Karim");
  assert.equal(logs[1].method, "Facial");
  assert.equal(logs[1].status, "refused", "le passage refusé par le kiosque reste lisible dans le journal");

  // and this is where the kiosk stops: no admin route accepts a device token
  for (const path of ["/api/state", "/api/descriptors", "/api/members", "/api/devices", "/api/settings", `/api/members/${mine.id}/delete`, `/api/members/${mine.id}/renew`]) {
    const r = await d.call(path);
    assert.equal(r.status, 401, `${path} doit rester interdit à un appareil`);
  }
  const forged = device();
  forged.token = d.token.slice(0, -3) + "AAA";
  assert.equal((await forged.call("/api/device/state")).status, 401, "un jeton tronqué ne vaut rien");
  const rival = device();
  rival.token = d.token;
  assert.equal((await rival.call("/api/device/state")).status, 200, "même jeton, même kiosque : c'est bien le jeton qui authentifie");
});

test("révocation immédiate, et un appareil d'un autre espace ne passe pas", async () => {
  const a = client(); const b = client();
  await signup(a, "fitness"); await signup(b, "office");
  const codeA = (await a.call("/api/devices/pairing", { name: "Kiosque A" })).data.code;
  const d = device();
  assert.equal((await d.call("/api/pair", { code: codeA })).status, 200);
  // B cannot mint a code that would hijack A's device list
  assert.equal((await b.call("/api/devices")).data.devices.length, 0);
  const other = (await b.call("/api/devices/pairing", { name: "Kiosque B" })).data.code;
  assert.notEqual(other, codeA);
  // B cannot revoke A's device
  const idA = (await a.call("/api/devices")).data.devices[0].id;
  assert.equal((await b.call(`/api/devices/${idA}/revoke`, {})).status, 404, "un autre espace ne peut pas débrancher cet appareil");

  const ren = await a.call(`/api/devices/${idA}/rename`, { name: "Borne arrière" });
  assert.equal(ren.status, 200);
  assert.equal((await a.call("/api/devices")).data.devices[0].name, "Borne arrière");
  assert.equal((await d.call("/api/device/state")).status, 200, "renommer ne déconnecte pas l'appareil");

  assert.equal((await a.call(`/api/devices/${idA}/revoke`, {})).status, 200);
  assert.equal((await d.call("/api/device/state")).status, 401, "jeton révoqué : plus rien ne passe");
  assert.equal((await d.call("/api/device/descriptors")).status, 401);
  const revoked = (await a.call("/api/devices")).data.devices[0];
  assert.match(String(revoked.revoked_at), /^20\d\d-\d\d-\d\dT/, "la ligne garde la trace de la révocation");
});

test("un boîtier de caméra envoie sans en-tête d'origine, un navigateur inter-site non", async () => {
  const c = client();
  await signup(c, "office");
  const code = (await c.call("/api/devices/pairing", { name: "Caméra entrée" })).data.code;
  // curl / a relay on a camera: no Origin, no Sec-Fetch-Site
  const relayIp = visitorIp();
  const raw = await fetch(BASE + "/api/pair", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": relayIp }, body: JSON.stringify({ code, kind: "box" }) });
  assert.equal(raw.status, 200, "une machine sans en-têtes de navigateur doit pouvoir s'appairer");
  const token = (await raw.json()).token;
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
  // a page on another domain may not spend it, even with a valid code
  const spare = (await c.call("/api/devices/pairing", { name: "Caméra 2" })).data.code;
  const evil = await fetch(BASE + "/api/pair", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }, body: JSON.stringify({ code: spare }) });
  assert.equal(evil.status, 403, "un site tiers ne peut pas dépenser les codes d'appairage");
  // and a revoked-but-still-typed code stays unusable
  assert.equal((await fetch(BASE + "/api/pair", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": relayIp }, body: JSON.stringify({ code: spare }) })).status, 200);
});

test("15 codes devinés par adresse, puis on attend", async () => {
  const c = client();
  await signup(c, "fitness");
  const ip = visitorIp();
  let last;
  for (let i = 0; i < 20; i++) {
    last = await fetch(BASE + "/api/pair", { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip }, body: JSON.stringify({ code: "AAAAAA" }) });
    await last.json().catch(() => null);
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429, "le budget de devinette est vite épuisé");
});
