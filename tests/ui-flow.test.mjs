// Browser-level tests for the Cloudflare Pages edition: the auth pages (login.html, signup.html +
// assets/auth.js) and the app shell (app.html + face.js + app.js) run inside a real DOM (jsdom)
// against a live `wrangler pages dev` server. Markup, form handling, fetch payloads, session
// cookies, rendering and CSP-safe styling are exercised the way a browser does it; face-api.js is
// replaced by a stub so the facial pipeline can be driven deterministically. API-only rules live in
// tests/cloudflare.test.mjs, the linked-device screens in tests/kiosk-ui.test.mjs.
//
// Usage: `npm run test:ui` (starts its own server) — or FACEID_URL=http://127.0.0.1:8788 npm run test:ui
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE, env, uniq, today, LAN_IP, waitFor, startServer, stopServer, makeJar, raw, space, openPage, fill, flashOf, descriptorFor } from "./browser-harness.mjs";

const PER_PAGE_TEST = 12;   // site/assets/app.js: douze lignes par page, jamais un mur de tableaux
const PORT = 8791;
let BASE = process.env.FACEID_URL || "";
let handle = null;
// Le poste live enchaîne des minuteurs — caméra qui se relance, direct, veilleur. Une fenêtre
// laissée ouverte continuerait donc de les reprogrammer et empêcherait le processus de mourir.
// Toute fenêtre ouverte ici est refermée à la fin du fichier, y compris sur une assertion qui échoue.
const opened = [];
const track = (ctx) => { opened.push(ctx); return ctx; };
const closeIt = (ctx) => { ctx.close(); const i = opened.indexOf(ctx); if (i >= 0) opened.splice(i, 1); };
let LAN_BASE = null;

before(async () => {
  if (!BASE) {
    handle = startServer({ port: PORT, d1: "DB=faceid-ui", persistTo: ".wrangler/test-ui" });
    BASE = handle.base;
  }
  env.BASE = BASE;
  await waitFor(BASE + "/api/healthz");
  LAN_BASE = env.LAN_BASE = LAN_IP ? `http://${LAN_IP}:${new URL(BASE).port || PORT}` : null;
});

after(() => { for (const ctx of opened) { try { ctx.close(); } catch (_) { /* déjà refermée */ } } stopServer(handle); });

test("landing page: every link it advertises resolves, including login and signup", async () => {
  const ctx = track(await openPage("/", makeJar()));
  const links = [...ctx.document.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  for (const href of ["/login", "/signup"]) assert.ok(links.includes(href), `${href} is linked from the landing page`);
  for (const href of [...new Set(links.filter((h) => h && h.startsWith("/") && !h.includes("#")))]) {
    assert.equal((await fetch(BASE + href)).status, 200, `${href} resolves`);
  }
  assert.equal(ctx.errors.length, 0, "the landing page is clean: " + ctx.errors.join(" | "));
});

test("signup form creates the company space and hands the browser over to the app", async () => {
  const jar = makeJar();
  const email = `signup-${uniq()}@example.com`;
  const ctx = track(await openPage("/signup", jar));
  const form = ctx.document.getElementById("auth-form");
  assert.equal(form.dataset.endpoint, "/api/signup", "the form posts to the signup endpoint");
  await fill(ctx, form, { company: "Salle UI " + uniq(), sector: "office", email: "  " + email.toUpperCase() + " ", password: "motdepasse-ui-123" });

  assert.deepEqual(ctx.calls.map((c) => c.path), ["/api/signup"]);
  assert.equal(ctx.calls[0].status, 200, JSON.stringify(ctx.calls[0].data));
  assert.equal(ctx.calls[0].data.redirect, "/app");
  assert.equal(flashOf(ctx).hidden, true, "no error banner after a valid signup");
  assert.ok(jar.has("sid"), "the browser kept the session cookie");
  assert.deepEqual(jar.dropped(), [], "the session cookie was not dropped by the browser");
  assert.equal(ctx.navigations.length, 1, "the page leaves for the app");
  assert.equal(form.querySelector("button[type=submit]").disabled, true, "the button stays disabled while leaving");

  const me = await raw("/api/me", { jar });
  assert.equal(me.data.user.email, email, "the email is stored lowercased and trimmed");
  assert.equal(me.data.user.sector, "office", "the chosen sector is remembered");
  assert.equal((await raw("/api/state", { jar })).status, 200, "and that session opens the space");
});

test("signup form: the password rule is written in the markup and enforced on the server", async () => {
  const ctx = track(await openPage("/signup", makeJar()));
  const password = ctx.document.querySelector('#auth-form input[name="password"]');
  assert.equal(password.getAttribute("minlength"), "12", "the browser itself refuses a shorter password");
  assert.equal(password.getAttribute("autocomplete"), "new-password", "the password manager offers a fresh password, not a saved one");
  assert.equal(ctx.document.querySelector('#auth-form input[name="email"]').getAttribute("autocomplete"), "username");
  assert.deepEqual([...ctx.document.querySelectorAll("#sector-select option")].map((o) => o.value), ["fitness", "office", "coworking", "canteen"], "all four sectors can be picked");
  const r = await raw("/api/signup", { body: { company: "Salle Courte", sector: "office", email: `short-${uniq()}@example.com`, password: "trop-court" }, jar: makeJar() });
  assert.equal(r.status, 400);
  assert.match(r.data.message, /12 à 256 caractères/, "the server says what to fix");
});

test("signup form: an email already taken is refused with a hint to log in", async () => {
  const { email } = await space("fitness");
  const ctx = track(await openPage("/signup", makeJar()));
  await fill(ctx, ctx.document.getElementById("auth-form"), { company: "Doublon", sector: "fitness", email, password: "motdepasse-doublon-12" });
  const flash = flashOf(ctx);
  assert.equal(flash.hidden, false);
  assert.match(flash.text, /Essayez de vous connecter/);
  assert.match(flash.cls, /flash-error/);
  assert.equal(ctx.navigations.length, 0, "the page does not move on failure");
  assert.equal(ctx.document.querySelector("button[type=submit]").disabled, false, "the button works again for a retry");
});

test("signup form: the sector preselected on the landing page is kept", async () => {
  const ctx = track(await openPage("/signup?sector=canteen", makeJar()));
  assert.equal(ctx.document.getElementById("sector-select").value, "canteen", "?sector=… preselects the sector");
});

test("login form: a wrong password explains itself, the right one opens the space", async () => {
  const { email, password } = await space("office");
  const jar = makeJar();
  const ctx = track(await openPage("/login", jar));
  const form = ctx.document.getElementById("auth-form");
  assert.equal(form.dataset.endpoint, "/api/login");

  await fill(ctx, form, { email, password: "mauvais-mot-de-passe" });
  const flash = flashOf(ctx);
  assert.match(flash.text, /Email ou mot de passe incorrect/);
  assert.match(flash.cls, /flash-error/);
  assert.equal(jar.has("sid"), false, "no session handed out on a failed login");
  assert.equal(ctx.navigations.length, 0, "the page does not move on failure");
  assert.equal(form.querySelector("button[type=submit]").disabled, false, "the button is clickable again");

  await fill(ctx, form, { email: "  inconnu@example.com  ", password: "mot-de-passe-inconnu-12" });
  assert.match(flashOf(ctx).text, /Email ou mot de passe incorrect/, "an unknown email is refused the same way");

  await fill(ctx, form, { email: email.toUpperCase(), password });
  assert.equal(flashOf(ctx).hidden, true, "the error banner is gone");
  assert.ok(jar.has("sid"), "a fresh session cookie was issued");
  assert.equal(ctx.navigations.length, 1, "the browser is sent to the app");
  assert.equal((await raw("/api/state", { jar })).status, 200, "the new session is accepted");
  assert.equal(ctx.errors.length, 0, "the login page is clean: " + ctx.errors.join(" | "));
});

test("a kiosk reached over plain HTTP keeps its session", async (t) => {
  if (!LAN_BASE) { t.skip("no second network address in this sandbox"); return; }
  // Outside a secure context browsers refuse a Secure cookie: a forced `Secure` flag made
  // signup answer 200 while /app bounced back to /login forever on http://192.168.1.20.
  const email = `lan-${uniq()}@example.com`;
  const jar = makeJar({ secure: false });
  const up = await raw("/api/signup", { body: { company: "Cantine LAN", sector: "canteen", email, password: "motdepasse-lan-123" }, jar, base: LAN_BASE });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.deepEqual(jar.dropped(), [], "no cookie was dropped for being Secure");
  assert.ok(jar.has("sid"), "the kiosk kept its session");
  assert.equal((await raw("/api/state", { jar, base: LAN_BASE })).status, 200, "the session authenticates over plain HTTP");

  jar.forget("sid"); // a returning visitor, back at the login form
  const ctx = track(await openPage("/login", jar, { base: LAN_BASE }));
  await fill(ctx, ctx.document.getElementById("auth-form"), { email, password: "motdepasse-lan-123" });
  assert.equal(ctx.calls[0].status, 200);
  assert.deepEqual(jar.dropped(), [], "the login cookie survived as well");
  assert.ok(jar.has("sid"));
  assert.equal(ctx.navigations.length, 1, "the kiosk lands on the app instead of looping back to /login");
});

test("logout invalidates the session everywhere", async () => {
  const { email, password } = await space("office");
  const jar = makeJar();
  assert.equal((await raw("/api/login", { body: { email, password }, jar })).status, 200);
  assert.equal((await raw("/api/state", { jar })).status, 200);
  const ctx = track(await openPage("/app", jar));
  ctx.document.getElementById("logout").click();
  await ctx.flush();
  assert.ok(ctx.calls.some((c) => c.path === "/api/logout"), "the logout was posted");
  assert.equal(ctx.navigations.length, 1, "and the browser returns to the landing page");
  assert.equal((await raw("/api/state", { jar })).status, 401, "the old cookie no longer authenticates");
});

// ---------------------------------------------------------------------------
// The app shell
// ---------------------------------------------------------------------------
test("/app without a session is sent back to the login page", async () => {
  const ctx = track(await openPage("/app", makeJar()));
  assert.deepEqual(ctx.calls.map((c) => c.path), ["/api/state"]);
  assert.equal(ctx.calls[0].status, 401);
  assert.equal(ctx.navigations.length, 1, "a redirect to /login is attempted");
  assert.match(ctx.document.getElementById("page").textContent, /Chargement/, "no private data is rendered meanwhile");
  closeIt(ctx);
});

test("a logged-in browser renders the dashboard of its own company", async () => {
  const { jar } = await space("office");
  const ctx = track(await openPage("/app", jar));
  const doc = ctx.document;
  assert.match(doc.getElementById("org-name").textContent, /^Espace office /);
  assert.match(doc.getElementById("user-email").textContent, /@example\.com$/);
  assert.match(doc.getElementById("org-sector").textContent, /PME & bureaux/);
  assert.equal(doc.body.className, "app sector-office", "the sector drives the whole vocabulary");
  assert.equal(doc.querySelectorAll(".stat").length, 5, "five KPIs");
  assert.match(doc.querySelector(".stat-label").textContent, /Employés/);
  assert.equal(doc.querySelectorAll(".chart .bar").length, 7, "seven days in the chart");
  for (const bar of doc.querySelectorAll(".chart .bar")) {
    assert.match(bar.style.height || "", /^\d+(\.\d+)?%$/, "the script gave every bar a real height (the CSP refuses a style attribute in markup)");
  }
  const csp = (await fetch(BASE + "/app")).headers.get("content-security-policy");
  assert.match(csp, /style-src 'self'/);
  assert.equal(/style-src[^;]*unsafe-inline/.test(csp), false, "the policy keeps inline styles refused");
  assert.deepEqual(ctx.inlineStyles, [], "no JS-rendered markup tries to use an inline style attribute");
  assert.equal(ctx.errors.length, 0, "the app page is clean: " + ctx.errors.join(" | "));
  closeIt(ctx);
});

test("members: add a person, quick dates stay on the company calendar, capture, renew, delete", async () => {
  const { jar } = await space("office");
  const ctx = track(await openPage("/app", jar));
  const doc = ctx.document;
  doc.defaultView.location.hash = "members";
  await ctx.flush();

  const form = doc.getElementById("add-member-form");
  assert.ok(form, "the add-member form is rendered");
  const companyToday = (await raw("/api/state", { jar })).data.today;
  doc.querySelector('.chip[data-days="0"]').click();
  await ctx.flush(3, 10);
  assert.equal(form.elements.subscription_end.value, companyToday, "« Journée » = today in the company's timezone, never yesterday");
  doc.querySelector('.chip[data-months="12"]').click();
  await ctx.flush(3, 10);
  const plusYear = form.elements.subscription_end.value;
  assert.equal(Number(plusYear.slice(0, 4)) - Number(companyToday.slice(0, 4)), 1, "« 1 an » lands on the same day next year");
  assert.equal(plusYear.slice(5), companyToday.slice(5), "…without drifting a day or a month");

  form.elements.name.value = "Amine Benali";
  form.querySelector("button.btn-ghost").click(); // « Ajouter sans visage »
  await ctx.flush();
  const added = ctx.calls.find((c) => c.path === "/api/members");
  assert.equal(added.status, 200, JSON.stringify(added.data));
  let row = [...doc.querySelectorAll("table tbody tr")].find((tr) => tr.textContent.includes("Amine Benali"));
  assert.ok(row, "the new member shows up in the list");
  assert.match(row.textContent, /Actif/);
  assert.match(row.textContent, /Capturer/, "a person without a face is offered the capture button");

  // capture: consent first, or nothing leaves the browser
  row.querySelector('[data-action="enroll"]').click();
  await ctx.flush();
  assert.equal(doc.getElementById("enroll-dialog").open, true, "the capture dialog opens modally");
  assert.match(doc.getElementById("enroll-status").textContent, /cochez|acc/i, "the dialog waits for the person to agree");
  doc.getElementById("enroll-capture").click();
  await ctx.flush();
  assert.match(doc.getElementById("enroll-status").textContent, /Cochez la case/, "consent is demanded before anything is captured");
  assert.equal(ctx.calls.some((c) => /\/enroll$/.test(c.path)), false, "nothing was sent without consent");

  ctx.state.faces = [descriptorFor(1)];
  const consent = doc.getElementById("enroll-consent");
  consent.checked = true;
  consent.dispatchEvent(new ctx.window.Event("change")); // starts the 3-2-1 countdown
  await ctx.flush(45, 120); // the 3-2-1 countdown, then the capture
  const enroll = ctx.calls.find((c) => /\/api\/members\/\d+\/enroll$/.test(c.path));
  assert.ok(enroll, "the countdown ended with the enrolment call");
  assert.equal(enroll.status, 200, JSON.stringify(enroll.data));
  assert.equal(ctx.state.loads, 1, "the facial engine is loaded once, on first use");
  assert.ok(ctx.calls.some((c) => c.path === "/api/descriptors"), "the browser refreshed the faces it knows");
  row = [...doc.querySelectorAll("table tbody tr")].find((tr) => tr.textContent.includes("Amine Benali"));
  assert.match(row.textContent, /Enregistré/, "the list shows the face as enrolled");

  // renewal
  const renew = doc.querySelector('form[data-api$="/renew"]');
  renew.elements.subscription_end.value = companyToday;
  await fill(ctx, renew, {});
  assert.ok(ctx.calls.some((c) => /\/renew$/.test(c.path) && c.status === 200), "the renewal was saved");

  // delete asks for confirmation and clears the row
  doc.defaultView.confirm = () => true;
  row = [...doc.querySelectorAll("table tbody tr")].find((tr) => tr.textContent.includes("Amine Benali"));
  row.querySelector('[data-action="delete"]').click();
  await ctx.flush();
  assert.equal([...doc.querySelectorAll("table tbody tr")].some((tr) => tr.textContent.includes("Amine Benali")), false, "the row is gone");
  assert.equal(ctx.errors.length, 0, "the members page is clean: " + ctx.errors.join(" | "));
});

test("settings: the space follows its own settings, invalid values are refused", async () => {
  const { jar } = await space("office");
  const ctx = track(await openPage("/app", jar));
  const doc = ctx.document;
  doc.defaultView.location.hash = "settings";
  await ctx.flush();
  const form = doc.querySelector('form[data-api="/api/settings"]');
  assert.ok(form, "the settings form is rendered");
  assert.match(form.elements.company.value, /^Espace office /, "the current name is prefilled");
  assert.equal(form.elements.sector.value, "office", "the current sector is prefilled");
  assert.equal(form.elements.timezone.value, "Africa/Algiers", "the default timezone is the company's");
  assert.equal(form.elements.work_start.value, "08:30");
  const renamed = "Bureau " + uniq();
  form.elements.company.value = renamed;
  await fill(ctx, form, {});
  assert.ok(ctx.calls.some((c) => c.path === "/api/settings" && c.status === 200), "the settings were saved");
  assert.equal(doc.getElementById("org-name").textContent, renamed, "the sidebar followed the rename");
  assert.equal((await raw("/api/settings", { body: { company: "X", sector: "office", timezone: "Mars/Olympus", work_start: "08:30", late_tolerance: 10 }, jar })).status, 400, "an unknown timezone is refused");
  assert.equal((await raw("/api/settings", { body: { company: "X", sector: "office", timezone: "UTC", work_start: "25:71", late_tolerance: 10 }, jar })).status, 400, "a nonsense hour is refused");
  assert.equal(ctx.errors.length, 0, "the settings page is clean: " + ctx.errors.join(" | "));
  closeIt(ctx);
});

test("the camera of the space starts itself, matches in the browser and logs the passage", async () => {
  const { jar } = await space("fitness");
  // a member with a face, enrolled before the camera opens so the browser feed holds it
  const name = "Sara " + uniq();
  const companyToday = (await raw("/api/state", { jar })).data.today;
  const member = (await raw("/api/members", { body: { name, subscription_end: companyToday }, jar })).data;
  assert.equal((await raw(`/api/members/${member.id}/enroll`, { body: { consent: true, descriptor: descriptorFor(7) }, jar })).status, 200);
  const known = await raw("/api/descriptors", { jar });
  assert.equal(known.data.members.length, 1, "the browser feed holds exactly one face");

  const ctx = track(await openPage("/app", jar, { faceState: { loads: 0, faces: [], box: { x: 0, y: 0, width: 300, height: 400 } } }));
  const doc = ctx.document;
  doc.defaultView.location.hash = "access";
  await ctx.flush(14, 40);

  // Personne n'appuie sur « Activer la caméra » : le poste s'allume, charge le moteur, et le dit.
  const video = doc.getElementById("rec-video");
  assert.ok(video, "the live dock carries the video surface");
  assert.equal(ctx.state.loads, 1, "the facial engine was loaded once, without a single click");
  assert.equal(doc.getElementById("rec-check").disabled, false, "verification is ready from the start");
  assert.ok(doc.getElementById("rec-auto").checked, "auto mode is on, and stays on");
  assert.match(doc.getElementById("rec-banner-title").textContent, /En attente d'un visage/, "a free camera says it is waiting for a face");
  assert.ok(doc.querySelector(".dot-live.on"), "the post is marked live, here and in the top bar");
  assert.match(doc.getElementById("bar-cam-text").textContent, /Cam\u00e9ra active/);

  // un cadre vide, comme un visage inconnu, ne coûtent aucun appel au serveur
  ctx.calls.length = 0;
  await ctx.flush(6, 40);
  assert.equal(ctx.calls.filter((c) => ["/api/recognized", "/api/entry", "/api/descriptors"].includes(c.path)).length, 0, "an empty frame never talks to the API");
  ctx.state.faces = [Array.from({ length: 128 }, (_, i) => (i % 2 ? 0.09 : -0.09))];
  await ctx.flush(8, 40);
  assert.match(doc.getElementById("rec-banner-title").textContent, /VISAGE INCONNU/);
  assert.equal(ctx.calls.filter((c) => c.path === "/api/recognized").length, 0, "an unmatched face never reaches the API");

  // la personne enregistrée : le verdict arrive, en fiche comme en journal
  ctx.state.faces = [known.data.members[0].d];
  doc.getElementById("rec-check").click();
  await ctx.flush(12, 40);
  assert.match(doc.getElementById("rec-banner-title").textContent, /ACCÈS AUTORIS\u00c9/, "the banner welcomes the member back");
  assert.equal(ctx.calls.find((c) => c.path === "/api/recognized").status, 200, "the browser sent the decision, the server logged it");
  assert.match(doc.querySelector(".live-list li").textContent, new RegExp(name.split(" ")[0]), "the live list shows the passage");
  assert.match(doc.getElementById("access-journal").textContent, /Sara/, "the journal below picked the passage up");
  const card = doc.querySelector('.toasts [data-verdict="granted"]');
  assert.ok(card, "a passage raises a notification card, not a plain banner");
  assert.match(card.textContent, /Sara/, "the card names the person");
  assert.ok(card.querySelector(".toast-icon svg"), "with its own icon");
  assert.ok(card.querySelector(".toast-close"), "and a way to close it");

  // la caméra suit l'écran : le flux n'est jamais coupé ni relancé par une navigation
  doc.defaultView.location.hash = "overview";
  await ctx.flush(8, 40);
  assert.equal(doc.getElementById("rec-video"), video, "the same video node travelled to the dashboard: the stream was never re-opened");
  assert.ok(doc.querySelector("#page .live-dock"), "and it is shown there, compactly");
  assert.match(video.srcObject ? "live" : "", /live/, "the MediaStream is still attached while browsing the space");
  assert.equal(ctx.state.loads, 1, "the engine was not loaded a second time either");

  // « Mettre en pause » n'éteint plus un poste : c'est une minute, puis il repart seul
  doc.defaultView.location.hash = "access";
  await ctx.flush(8, 40);
  doc.getElementById("rec-start").click();
  await ctx.flush(6, 30);
  assert.match(doc.getElementById("rec-start").textContent, /Reprendre/, "the button becomes a way back in, never a dead switch");
  assert.match(doc.getElementById("rec-banner-text").textContent, /reprendra tout seul/i, "the pause announces its own end");
  assert.equal(doc.getElementById("rec-check").disabled, true, "while paused, nothing is scanned");
  doc.getElementById("rec-start").click();
  await ctx.flush(16, 40);
  assert.equal(doc.getElementById("rec-check").disabled, false, "and it is back without anyone reconfiguring the post");
  assert.equal(ctx.errors.length, 0, "the kiosk is clean: " + ctx.errors.join(" | "));
  closeIt(ctx);
});

test("a refused camera on the office post retries itself until it is allowed", async () => {
  const { jar } = await space("coworking");
  const ctx = track(await openPage("/app#settings", jar, { faceState: { loads: 0, faces: [], box: { x: 0, y: 0, width: 300, height: 400 } } }));
  await ctx.flush(14, 40);
  const doc = ctx.document;
  assert.ok(doc.getElementById("rec-video"), "even on the settings screen the live post keeps its node");
  assert.ok(doc.getElementById("rec-video").closest(".dock-holder"), "it is parked out of sight, not unmounted");
  const cam = ctx.window.navigator.mediaDevices;
  const working = cam.getUserMedia;
  doc.getElementById("rec-start").click();                      // pause
  await ctx.flush(3, 20);
  cam.getUserMedia = async () => { throw Object.assign(new Error("busy"), { name: "NotReadableError" }); };
  doc.querySelector('[data-action="camera-test"]').click();      // reprise -> caméra tenue ailleurs
  await ctx.flush(8, 40);
  assert.match(doc.getElementById("rec-banner-text").textContent, /caméra/i, "the refusal is explained, on the video itself");
  const card = doc.querySelector('.toasts [data-tag="camera"]');
  assert.ok(card, "and as a notification card with a way out");
  assert.match(card.textContent, /r\u00e9essaie seul/i, "the card says the post retries on its own");
  assert.ok([...card.querySelectorAll("button")].some((b) => /Réessayer/.test(b.textContent)), "with a button to force the next try");
  assert.equal(doc.querySelectorAll('.toasts [data-tag="camera"]').length, 1, "one card per subject, never a stack of the same complaint");
  // le poste se libère : personne ne retouche la page, le direct revient
  cam.getUserMedia = working;
  [...card.querySelectorAll("button")].find((b) => /R\u00e9essayer/.test(b.textContent)).click();
  await ctx.flush(20, 40);
  assert.equal(doc.getElementById("rec-check").disabled, false, "the camera came back on its own");
  assert.ok(doc.getElementById("rec-auto").checked, "auto mode came back with it");
  assert.equal(doc.querySelectorAll('.toasts [data-tag="camera"]').length, 0, "and the complaint retires itself once the camera is back");
  closeIt(ctx);
});

test("the space learns about another post's passages without a reload", async () => {
  const { jar } = await space("office");
  const name = "Nadia " + uniq();
  const member = (await raw("/api/members", { jar, body: { name, subscription_end: today } })).data;
  await raw(`/api/members/${member.id}/enroll`, { jar, body: { descriptor: descriptorFor(5), consent: true } });
  const code = (await raw("/api/devices/pairing", { jar, body: { name: "Borne hall", kind: "kiosk" } })).data.code;
  const kiosk = makeJar();
  assert.equal((await raw("/api/pair", { jar: kiosk, body: { code } })).status, 200, "the post is paired");

  const ctx = track(await openPage("/app#overview", jar, { faceState: { loads: 0, faces: [], box: { x: 0, y: 0, width: 300, height: 400 } } }));
  await ctx.flush(12, 40);
  const doc = ctx.document;
  assert.equal(doc.querySelectorAll('[data-live="journal"] table tbody tr').length, 0, "the journal starts empty");

  // la borne, elle, enregistre un passage : l'espace ne doit pas avoir à être rechargé
  const entry = await raw("/api/device/recognized", { jar: kiosk, body: { member_id: member.id, distance: 0.21 } });
  assert.equal(entry.status, 200, JSON.stringify(entry.data));
  await ctx.flush(110, 70);                     // plus que le pas du direct (5 s)
  const row = doc.querySelector('[data-live="journal"] table tbody tr');
  assert.ok(row, "the line appeared by itself, no F5");
  assert.match(row.textContent, /Nadia/);
  assert.match(row.textContent, /Borne hall/, "and it tells which post saw it");
  const card = doc.querySelector('.toasts [data-verdict="granted"]');
  assert.ok(card, "with a card on the edge of the screen");
  assert.match(card.textContent, /Borne hall/, "naming the post it came from");
  assert.match(card.textContent, /pointage|accès/i, "and repeating the sentence the kiosk spoke");
  const pointage = [...doc.querySelectorAll(".stat")].find((s) => /Pointages aujourd/.test(s.textContent));
  assert.equal(pointage.querySelector(".stat-value").textContent, "1", "the KPI followed");
  assert.ok(doc.querySelectorAll('[data-live="today"] .live-list li').length >= 1, "and the live strip of the space shows it too");
  doc.defaultView.location.hash = "access";
  await ctx.flush(8, 40);
  assert.match(doc.getElementById("access-journal").textContent, /Nadia/, "the other screen reads the same live data, without a reload");
  closeIt(ctx);
});

test("period, search, filters and pages are answered by the screen, not by a reload", async () => {
  const { jar } = await space("canteen");
  const companyToday = (await raw("/api/state", { jar })).data.today;
  const expired = (await raw("/api/members", { jar, body: { name: "Hakim " + uniq(), subscription_end: "2020-01-01" } })).data;
  assert.ok(expired.id, "an expired member exists");
  for (let i = 0; i < 13; i++) {
    assert.equal((await raw("/api/members", { jar, body: { name: `Inscrit ${i} ` + uniq(), subscription_end: companyToday } })).status, 200);
  }
  const ctx = track(await openPage("/app#members", jar));
  await ctx.flush(12, 40);
  const doc = ctx.document;
  assert.equal(doc.querySelectorAll("table tbody tr").length, PER_PAGE_TEST, "the list is paginated, never endless");
  assert.match(doc.querySelector(".pager").textContent, /1 \/ 2/);
  doc.querySelector('[data-action="pager"][data-page="2"]').click();
  await ctx.flush(4, 30);
  assert.match(doc.querySelector(".pager").textContent, /2 \/ 2/, "the next page is the last one");
  doc.querySelector('[data-action="pager"][data-page="1"]').click();
  await ctx.flush(4, 30);

  const box = doc.querySelector('[data-action="search"][data-target="members"]');
  box.value = "Hakim";
  box.dispatchEvent(new ctx.window.Event("input", { bubbles: true }));
  await ctx.flush(6, 40);
  assert.equal(doc.querySelectorAll("table tbody tr").length, 1, "the search kept a single row");
  assert.ok(doc.querySelector("mark"), "and shows why it kept that one");
  box.value = "";
  box.dispatchEvent(new ctx.window.Event("input", { bubbles: true }));
  await ctx.flush(6, 40);
  doc.querySelector('.filters [data-value="expired"]').click();
  await ctx.flush(4, 30);
  assert.equal(doc.querySelectorAll("table tbody tr").length, 1, "the filter answers on the spot");
  assert.match(doc.querySelector("table tbody tr").textContent, /Expir/);
  doc.querySelector('.filters [data-value="all"]').click();
  await ctx.flush(4, 30);

  doc.defaultView.location.hash = "overview";
  await ctx.flush(8, 40);
  assert.equal(doc.querySelectorAll(".chart .bar").length, 7, "seven days by default");
  doc.querySelector('[data-action="period"][data-days="30"]').click();
  await ctx.flush(10, 40);
  assert.equal(doc.querySelectorAll(".chart .bar").length, 30, "the period tab redraws the chart");
  assert.equal(doc.querySelector('[data-action="period"][data-days="30"]').getAttribute("aria-pressed"), "true", "and the tab stays pressed");
  assert.ok(doc.querySelector('.steps-board .step-item'), "the board says what to do next");
  const journalRow = doc.querySelectorAll("#page table tbody tr").length;
  assert.ok(journalRow >= 0);
  assert.equal(ctx.errors.length, 0, "the screens are clean: " + ctx.errors.join(" | "));
  closeIt(ctx);
});

test("the notification stack is bounded, closable and muteable from the bar", async () => {
  const { jar } = await space("fitness");
  const ctx = track(await openPage("/app#access", jar));
  await ctx.flush(12, 40);
  const doc = ctx.document;
  for (let i = 0; i < 7; i++) {
    doc.querySelector('[data-action="journal-help"]').click();
    await ctx.flush(2, 10);
  }
  const cards = doc.querySelectorAll(".toasts .toast:not(.toast-out)");
  assert.ok(cards.length > 0 && cards.length <= 4, "the stack holds at most four cards, here " + cards.length);
  assert.ok(doc.querySelector(".toasts[role='region']"), "the stack is an announced region");
  cards[0].querySelector(".toast-close").click();
  await ctx.flush(4, 30);
  await ctx.flush(10, 30);
  assert.equal(doc.querySelectorAll(".toasts .toast:not(.toast-out)").length, cards.length - 1, "a card closes for good");
  const sound = doc.getElementById("bar-sound");
  const before = sound.getAttribute("aria-pressed");
  sound.click();
  await ctx.flush(2, 10);
  assert.notEqual(sound.getAttribute("aria-pressed"), before, "the bar toggles the sound");
  assert.equal(ctx.window.localStorage.getItem("faceid.sound") === "off", before === "true", "and the choice survives on this post");
  sound.click();
  closeIt(ctx);
  assert.equal(ctx.errors.length, 0, "the stack is clean: " + ctx.errors.join(" | "));
});

test("every screen of the app stays free of inline styles and console errors", async () => {
  const { jar } = await space("canteen");
  for (const path of ["/", "/login", "/signup", "/app"]) {
    const ctx = track(await openPage(path, jar));
    for (const page of ["overview", "members", "access", "settings"]) {
      ctx.window.location.hash = page;
      await ctx.flush(6, 30);
    }
    assert.deepEqual(ctx.inlineStyles, [], `${path} × every page injects no inline style attribute`);
    assert.equal(ctx.errors.length, 0, `${path} is clean: ` + ctx.errors.join(" | "));
    closeIt(ctx);
  }
  const staticHtml = ["index", "login", "signup", "app"].map((n) => readFileSync(join(SITE, `${n}.html`), "utf8")).join("\n");
  assert.equal(/\sstyle=/.test(staticHtml), false, "the static HTML carries no style attribute either");
});
