// Shared browser-test harness for the Cloudflare Pages edition: a cookie jar with real cookie
// semantics, a raw API client, an isolated `wrangler pages dev` launcher and a jsdom page loader
// that runs each page's own scripts against the HTML the server actually sends. face-api.js is
// replaced by a stub so the facial pipeline can be driven deterministically.
// Used by tests/ui-flow.test.mjs (auth pages + app shell) and tests/kiosk-ui.test.mjs (kiosk).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SITE = join(ROOT, "site");

// Which server the helpers talk to; a test file sets both entries once, in before().
export const env = { BASE: "", LAN_BASE: "" };

export async function waitFor(url, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start: " + url);
}

/** An isolated dev server: its own port, its own D1 database, its own state directory. */
export function startServer({ port, d1, persistTo }) {
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn("npx", ["wrangler", "pages", "dev", "site", "--d1", d1, "--port", String(port), "--ip", "0.0.0.0", "--persist-to", persistTo], { cwd: ROOT, stdio: "ignore", detached: true });
  return { base, proc };
}

export function stopServer(handle) {
  if (!handle || !handle.proc) return;
  try { process.kill(-handle.proc.pid, "SIGTERM"); } catch (_) { try { handle.proc.kill("SIGTERM"); } catch (_) { /* already gone */ } }
}

export const uniq = () => Math.random().toString(36).slice(2, 8);
export const today = new Date().toISOString().slice(0, 10);
export const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
// The kiosk scenario: same app, reached through a plain-HTTP address that is not loopback.
export const LAN_IP = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;


// ---------------------------------------------------------------------------
// Cookie jar with browser semantics: a Secure cookie is refused outside a secure context.
// ---------------------------------------------------------------------------
let visitors = 0;
export function makeJar({ secure = true } = {}) {
  const store = new Map();
  const dropped = [];
  visitors += 1;
  // Rate limits are keyed per visitor: a random TEST-NET-2 address keeps two runs of the
  // same test file from sharing a bucket through the persisted local D1 state.
  const ip = `198.51.${(visitors * 7 + Math.floor(Math.random() * 200)) % 256}.${(visitors * 43 + Math.floor(Math.random() * 200)) % 254 + 1}`;
  return {
    absorb(res) {
      const lines = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
      for (const line of lines) {
        const [pair, ...attrs] = line.split(";");
        const at = pair.indexOf("=");
        const name = pair.slice(0, at).trim();
        const value = pair.slice(at + 1).trim();
        const flags = attrs.map((a) => a.trim().toLowerCase());
        if (flags.includes("secure") && !secure) { dropped.push(name); continue; }
        if (value === "" || flags.includes("max-age=0")) store.delete(name);
        else store.set(name, value);
      }
    },
    ip,
    cookie: () => [...store].map(([k, v]) => `${k}=${v}`).join("; "),
    has: (name) => store.has(name),
    dropped: () => [...dropped],
    forget: (name) => store.delete(name),
  };
}

export async function raw(path, { method, body, jar, headers = {}, base = env.BASE } = {}) {
  // Un visiteur sans jar (healthz, secteurs) prend une adresse au hasard : les budgets de
  // tentatives sont par IP et l'état local d'un serveur réutilisé les garde entre deux executions.
  const h = new Headers({ "CF-Connecting-IP": (jar && jar.ip) || `198.51.100.${1 + Math.floor(Math.random() * 254)}`, ...headers });
  if (!h.has("Origin")) h.set("Origin", base);
  if (!h.has("Sec-Fetch-Site")) h.set("Sec-Fetch-Site", "same-origin");
  if (jar && jar.cookie()) h.set("Cookie", jar.cookie());
  if (body !== undefined) h.set("Content-Type", "application/json");
  const res = await fetch(base + path, { method: method || (body !== undefined ? "POST" : "GET"), headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
  if (jar) jar.absorb(res);
  let data = null;
  try { data = await res.clone().json(); } catch (_) { /* html */ }
  return { status: res.status, data, headers: res.headers };
}

// One company per sector, created through the API, so each DOM test stands on its own.
export const spaces = new Map();
export async function space(sector = "office") {
  if (!spaces.has(sector)) {
    const jar = makeJar();
    const email = `ui-${sector}-${uniq()}@example.com`;
    const r = await raw("/api/signup", { body: { company: `Espace ${sector} ${uniq()}`, sector, email, password: "motdepasse-ui-123" }, jar });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const state = await raw("/api/state", { jar });
    spaces.set(sector, { jar, email, password: "motdepasse-ui-123", state: state.data });
  }
  return spaces.get(sector);
}

// ---------------------------------------------------------------------------
// DOM harness: the HTML the server actually sends, plus that page's own scripts.
// jsdom has no CSP engine, so inline-style injection is caught by watching innerHTML.
// ---------------------------------------------------------------------------
export function makeFaceEngineStub(faceState) {
  return {
    tf: { setBackend: async () => true, ready: async () => {}, getBackend: () => "test" },
    nets: {
      tinyFaceDetector: { loadFromUri: async () => { faceState.loads += 1; } },
      faceLandmark68TinyNet: { loadFromUri: async () => {} },
      faceRecognitionNet: { loadFromUri: async () => {} },
    },
    TinyFaceDetectorOptions: class { constructor(options) { Object.assign(this, options); } },
    detectAllFaces: () => ({
      withFaceLandmarks: () => ({
        withFaceDescriptors: async () => faceState.faces.map((d) => ({ descriptor: Float32Array.from(d), detection: { box: { ...faceState.box, area: faceState.box.width * faceState.box.height } } })),
      }),
    }),
  };
}

export async function openPage(path, jar, { base = env.BASE, faceState } = {}) {
  const state = faceState || { loads: 0, faces: [], box: { x: 0, y: 0, width: 300, height: 400 } };
  const html = await (await fetch(base + path)).text();
  const navigations = [];
  const errors = [];
  const inlineStyles = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (err) => {
    if (/not implemented: navigation/i.test(err.message)) navigations.push(err.message);
    else errors.push("jsdomError: " + err.message);
  });

  const dom = new JSDOM(html, { url: base + path, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  window.faceapi = makeFaceEngineStub(state);

  // the handful of browser APIs jsdom does not ship
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.HTMLMediaElement.prototype.pause = () => {};
  try {
    Object.defineProperty(window.HTMLMediaElement.prototype, "srcObject", {
      configurable: true,
      get() { return this.__srcObject ?? null; },
      set(value) { this.__srcObject = value; },
    });
  } catch (_) { /* jsdom ships a usable one */ }
  for (const [prop, value] of [["videoWidth", 640], ["videoHeight", 480]]) {
    try { Object.defineProperty(window.HTMLVideoElement.prototype, prop, { configurable: true, get: () => value }); } catch (_) { /* provided by jsdom */ }
  }
  window.Audio = class { constructor() { this.paused = true; this.ended = true; } play() { return Promise.resolve(); } pause() {} set src(_v) {} get src() { return ""; } };
  const dialog = window.HTMLDialogElement.prototype;
  if (typeof dialog.showModal !== "function" || typeof dialog.close !== "function") {
    Object.defineProperty(dialog, "open", { configurable: true, get() { return this.__open === true; } });
    dialog.show = function () { this.__open = true; };
    dialog.showModal = function () { this.__open = true; };
    dialog.close = function () { this.__open = false; };
  }
  window.confirm = () => true;
  window.alert = () => {};
  try {
    Object.defineProperty(window.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ kind: "video", stop() {}, addEventListener() {}, removeEventListener() {} }] }) },
    });
  } catch (_) { /* leave it absent: the "no camera" branch then runs */ }

  // A style attribute written into markup is refused by `style-src 'self'`: record it.
  const innerHTML = Object.getOwnPropertyDescriptor(window.Element.prototype, "innerHTML");
  Object.defineProperty(window.Element.prototype, "innerHTML", {
    configurable: true,
    get() { return innerHTML.get.call(this); },
    set(value) {
      const at = typeof value === "string" ? value.search(/\sstyle\s*=/) : -1;
      if (at >= 0) inlineStyles.push(value.slice(Math.max(0, at - 40), at + 90));
      innerHTML.set.call(this, value);
    },
  });

  const calls = [];
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, base);
    const r = await raw(url.pathname + url.search, {
      method: init.method,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      jar,
      base,
      headers: init.headers,
    });
    calls.push({ path: url.pathname, status: r.status, data: r.data });
    return new Response(JSON.stringify(r.data ?? {}), { status: r.status, headers: { "Content-Type": "application/json" } });
  };

  for (const src of [...window.document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"))) {
    const file = join(SITE, src.replace(/^\//, ""));
    if (!existsSync(file)) { errors.push(`the page loads ${src} but the file is missing`); continue; }
    if (src.includes("face-api.js")) continue; // replaced by the stub above (1.3 MB of TF.js is not the subject)
    window.eval(readFileSync(file, "utf8"));
  }
  const flush = async (rounds = 12, ms = 40) => { for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, ms)); };
  await flush();
  // A live page chains its own timers (camera retries, the direct feed, a watchdog): each link is
  // created after an `await`, so jsdom's close() alone cannot stop it — the pending promise still
  // runs and schedules one more timer, forever. A closed window must not be able to schedule work.
  const close = () => {
    try { window.setTimeout = () => 0; window.setInterval = () => 0; } catch (_) { /* sealed realm */ }
    try { window.close(); } catch (_) { /* already torn down */ }
  };
  return { window, dom, document: window.document, calls, navigations, errors, inlineStyles, state, flush, close };
}

export async function fill(ctx, form, fields) {
  for (const [name, value] of Object.entries(fields)) {
    const el = form.elements[name];
    assert.ok(el, `the form has a "${name}" field`);
    el.value = value;
  }
  form.requestSubmit();
  await ctx.flush();
}

export const flashOf = (ctx) => {
  const el = ctx.document.getElementById("flash");
  return { hidden: el.hidden, text: el.textContent.trim(), cls: el.className };
};

export const descriptorFor = (seed) => Array.from({ length: 128 }, (_, i) => Math.sin(seed + i) / 11);
