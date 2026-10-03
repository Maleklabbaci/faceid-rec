// End-to-end tests for the Cloudflare Pages edition (functions/api + D1), run against a
// local `wrangler pages dev` server. Usage: `npm test` (starts the server itself) or set
// FACEID_URL=http://127.0.0.1:8788 to reuse a running one.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 8790;
let BASE = process.env.FACEID_URL || "";
let server = null;

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
    server = spawn("npx", ["wrangler", "pages", "dev", "site", "--d1", "DB=faceid", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", ".wrangler/test-state"], { stdio: "ignore" });
  }
  await waitFor(BASE + "/api/healthz");
});
after(() => { if (server) server.kill("SIGTERM"); });

// Minimal cookie-aware client, same-origin headers like a browser fetch.
function client() {
  let cookie = "";
  const ip = `198.51.100.${Math.floor(Math.random() * 254) + 1}`; // one "visitor" per client (rate limits are per IP)
  async function call(path, body, method, extraHeaders = {}) {
    const headers = { Origin: BASE, "Sec-Fetch-Site": "same-origin", "CF-Connecting-IP": ip, ...extraHeaders };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(BASE + path, { method: method || (body !== undefined ? "POST" : "GET"), headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    let data = null;
    try { data = await res.json(); } catch (_) { /* static */ }
    return { status: res.status, data, headers: res.headers };
  }
  return { call, cookies: () => cookie };
}

const uniq = () => Math.random().toString(36).slice(2, 8);
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

test("login rate limit", async () => {
  const c = client();
  let last;
  for (let i = 0; i < 11; i++) last = await c.call("/api/login", { email: `nobody-${uniq()}@example.com`, password: "x" }, "POST", { "CF-Connecting-IP": "203.0.113.9" });
  assert.equal(last.status, 429);
});
