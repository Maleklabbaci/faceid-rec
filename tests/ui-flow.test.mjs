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

const PORT = 8791;
let BASE = process.env.FACEID_URL || "";
let handle = null;
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

after(() => stopServer(handle));

test("landing page: every link it advertises resolves, including login and signup", async () => {
  const ctx = await openPage("/", makeJar());
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
  const ctx = await openPage("/signup", jar);
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
  const ctx = await openPage("/signup", makeJar());
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
  const ctx = await openPage("/signup", makeJar());
  await fill(ctx, ctx.document.getElementById("auth-form"), { company: "Doublon", sector: "fitness", email, password: "motdepasse-doublon-12" });
  const flash = flashOf(ctx);
  assert.equal(flash.hidden, false);
  assert.match(flash.text, /Essayez de vous connecter/);
  assert.match(flash.cls, /flash-error/);
  assert.equal(ctx.navigations.length, 0, "the page does not move on failure");
  assert.equal(ctx.document.querySelector("button[type=submit]").disabled, false, "the button works again for a retry");
});

test("signup form: the sector preselected on the landing page is kept", async () => {
  const ctx = await openPage("/signup?sector=canteen", makeJar());
  assert.equal(ctx.document.getElementById("sector-select").value, "canteen", "?sector=… preselects the sector");
});

test("login form: a wrong password explains itself, the right one opens the space", async () => {
  const { email, password } = await space("office");
  const jar = makeJar();
  const ctx = await openPage("/login", jar);
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
  const ctx = await openPage("/login", jar, { base: LAN_BASE });
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
  const ctx = await openPage("/app", jar);
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
  const ctx = await openPage("/app", makeJar());
  assert.deepEqual(ctx.calls.map((c) => c.path), ["/api/state"]);
  assert.equal(ctx.calls[0].status, 401);
  assert.equal(ctx.navigations.length, 1, "a redirect to /login is attempted");
  assert.match(ctx.document.getElementById("page").textContent, /Chargement/, "no private data is rendered meanwhile");
});

test("a logged-in browser renders the dashboard of its own company", async () => {
  const { jar } = await space("office");
  const ctx = await openPage("/app", jar);
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
});

test("members: add a person, quick dates stay on the company calendar, capture, renew, delete", async () => {
  const { jar } = await space("office");
  const ctx = await openPage("/app", jar);
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
  const ctx = await openPage("/app", jar);
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
});

test("the kiosk page starts the camera, matches in the browser and logs the passage", async () => {
  const { jar } = await space("fitness");
  // a member with a face, enrolled before the kiosk opens so the browser feed holds it
  const name = "Sara " + uniq();
  const companyToday = (await raw("/api/state", { jar })).data.today; // the kiosk's own calendar day
  const member = (await raw("/api/members", { body: { name, subscription_end: companyToday }, jar })).data;
  assert.equal((await raw(`/api/members/${member.id}/enroll`, { body: { consent: true, descriptor: descriptorFor(7) }, jar })).status, 200);
  const known = await raw("/api/descriptors", { jar });
  assert.equal(known.data.members.length, 1, "the browser feed holds exactly one face");

  const ctx = await openPage("/app", jar, { faceState: { loads: 0, faces: [], box: { x: 0, y: 0, width: 300, height: 400 } } });
  const doc = ctx.document;
  doc.defaultView.location.hash = "access";
  await ctx.flush();
  assert.ok(doc.getElementById("rec-video"), "the kiosk video surface exists");
  assert.equal(doc.getElementById("rec-check").disabled, true, "verification stays off until the camera runs");
  assert.match(doc.getElementById("rec-banner-title").textContent, /Caméra inactive/);

  doc.getElementById("rec-start").click();
  await ctx.flush();
  assert.equal(ctx.state.loads, 1, "the facial engine was loaded once");
  assert.equal(doc.getElementById("rec-check").disabled, false, "manual verification unlocked");
  assert.equal(doc.getElementById("rec-auto").disabled, false, "kiosk mode unlocked");
  assert.match(doc.getElementById("rec-status").textContent, /1 visage\(s\) connus/, "the status tells how many faces are known");

  ctx.calls.length = 0;
  doc.getElementById("rec-check").click();
  await ctx.flush();
  assert.match(doc.getElementById("rec-banner-title").textContent, /En attente d'un visage/, "an empty frame says so");
  assert.equal(ctx.calls.length, 0, "…without costing an API call");

  ctx.state.faces = [descriptorFor(42)]; // a stranger
  doc.getElementById("rec-check").click();
  await ctx.flush();
  assert.match(doc.getElementById("rec-banner-title").textContent, /VISAGE INCONNU/);
  assert.equal(ctx.calls.length, 0, "an unmatched face never reaches the API");

  ctx.state.faces = [known.data.members[0].d]; // the member, seen through the same camera
  doc.getElementById("rec-check").click();
  await ctx.flush();
  assert.match(doc.getElementById("rec-banner-title").textContent, /ACCÈS AUTORISÉ/, "the banner welcomes the member back");
  assert.equal(ctx.calls.find((c) => c.path === "/api/recognized").status, 200, "the browser sent the decision, the server logged it");
  assert.match(doc.querySelector(".live-list li").textContent, new RegExp(name.split(" ")[0]), "the live list shows the passage");
  assert.match(doc.getElementById("access-journal").textContent, /Sara/, "the journal below picked the passage up");
  assert.equal(ctx.errors.length, 0, "the kiosk is clean: " + ctx.errors.join(" | "));

  doc.getElementById("rec-start").click(); // cut the camera again
  await ctx.flush();
  assert.match(doc.getElementById("rec-banner-title").textContent, /Caméra inactive/, "and the camera really stops");
});

test("every screen of the app stays free of inline styles and console errors", async () => {
  const { jar } = await space("canteen");
  for (const path of ["/", "/login", "/signup", "/app"]) {
    const ctx = await openPage(path, jar);
    for (const page of ["overview", "members", "access", "settings"]) {
      ctx.window.location.hash = page;
      await ctx.flush(6, 30);
    }
    assert.deepEqual(ctx.inlineStyles, [], `${path} × every page injects no inline style attribute`);
    assert.equal(ctx.errors.length, 0, `${path} is clean: ` + ctx.errors.join(" | "));
  }
  const staticHtml = ["index", "login", "signup", "app"].map((n) => readFileSync(join(SITE, `${n}.html`), "utf8")).join("\n");
  assert.equal(/\sstyle=/.test(staticHtml), false, "the static HTML carries no style attribute either");
});
