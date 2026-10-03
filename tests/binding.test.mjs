// Unit tests for the D1 binding guard: a Pages project whose `DB` binding is a variable, a KV
// namespace or a Durable Object — instead of the `faceid` D1 database — used to answer every
// request with a bare 500 and `TypeError: env.DB.prepare is not a function` in the invocation
// log. These need no server: they call the Functions module directly with fake env objects.
import { test } from "node:test";
import assert from "node:assert/strict";

const { onRequest } = await import(new URL("../functions/api/%5B%5Broute%5D%5D.js", import.meta.url).href);

const ORIGIN = "https://saaspromax.pages.dev";

function call(path, { method = "GET", env, body } = {}) {
  const headers = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const request = new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return onRequest({ request, env: env || {}, waitUntil() {}, next: async () => new Response("ok") });
}

const workingD1 = { prepare: () => ({ bind() { return this; }, first: async () => ({}) }) };

test("healthz explains a missing binding instead of hiding behind a 500", async () => {
  const res = await call("/api/healthz", { env: {} });
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.db, false);
  assert.equal(data.detail, "missing");
  assert.match(data.message, /Base D1 non liée sous le nom « DB »/);
  assert.match(data.message, /Settings → Bindings/);
});

test("healthz names the wrong binding: a plain variable that shadows DB", async () => {
  // the classic mistake: a *variable* DB = "faceid" where a D1 *binding* is expected
  const res = await call("/api/healthz", { env: { DB: "faceid" } });
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.detail, "wrong-type");
  assert.match(data.message, /ce n'est pas une base D1/);
  assert.match(data.message, /variable texte/);
  assert.doesNotMatch(JSON.stringify(data), /prepare is not a function/, "no raw TypeError left for the visitor");
});

test("healthz recognises the other binding types it can be confused with", async () => {
  const kv = await call("/api/healthz", { env: { DB: { get() {}, put() {}, list() {} } } });
  assert.match((await kv.json()).message, /namespace KV/);
  const r2 = await call("/api/healthz", { env: { DB: { get() {}, put() {} } } });
  assert.match((await r2.json()).message, /bucket R2/);
  const dobj = await call("/api/healthz", { env: { DB: { idFromName() {} } } });
  assert.match((await dobj.json()).message, /Durable Object/);
});

test("every other route answers politely, including signup and login", async () => {
  for (const env of [{}, { DB: "faceid" }, { DB: { get() {}, list() {} } }]) {
    const signup = await call("/api/signup", { method: "POST", env, body: { company: "Salle", sector: "fitness", email: "a@b.dz", password: "motdepasse-long-12" } });
    assert.equal(signup.status, 503);
    const data = await signup.json();
    assert.equal(data.ok, false);
    assert.match(data.message, /base de données non reliée/i, "the counter gets a sentence, not a stack trace");
    assert.match(data.hint, /Retry deployment/, "the administrator gets the fix steps");
    assert.equal(data.status, "error");
    const login = await call("/api/login", { method: "POST", env, body: { email: "a@b.dz", password: "x" } });
    assert.equal(login.status, 503);
    assert.equal((await login.json()).hint.includes("faceid"), true);
  }
});

test("a real D1 binding still reports ok", async () => {
  const res = await call("/api/healthz", { env: { DB: workingD1, PEPPER: "secret" } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok", db: true, pepper: true });
});

test("healthz reports a database that refuses queries rather than throwing", async () => {
  const res = await call("/api/healthz", { env: { DB: { prepare: () => ({ first: async () => { throw new Error("D1_ERROR: no such table: users"); } }) } } });
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.db, false);
  assert.match(data.message, /no such table: users/);
});
