// Browser-level tests for the linked-device feature: the kiosk page (site/kiosk.html +
// assets/kiosk.js) and the « Appareils reliés » screen of the company space (rendered by
// assets/app.js from /api/devices). Same jsdom harness as tests/ui-flow.test.mjs: the served HTML,
// the page's own scripts, a stubbed face engine, and the real API on a `wrangler pages dev` server.
//
// Usage: `npm run test:kiosk` — or FACEID_URL=http://127.0.0.1:8788 npm run test:kiosk
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE, env, uniq, today, waitFor, startServer, stopServer, makeJar, raw, space, openPage, descriptorFor } from "./browser-harness.mjs";

const PORT = 8792;
let BASE = process.env.FACEID_URL || "";
let handle = null;
// A kiosk page keeps its own scan loop alive; every window opened by a test is closed at the end of
// the run, so a failing assertion cannot leave a timer chain holding the process open.
const opened = [];
const track = (ctx) => { opened.push(ctx); return ctx; };

before(async () => {
  if (!BASE) {
    handle = startServer({ port: PORT, d1: "DB=faceid-kiosk", persistTo: ".wrangler/test-kiosk" });
    BASE = handle.base;
  }
  env.BASE = BASE;
  await waitFor(BASE + "/api/healthz");
});

after(async () => {
  for (const ctx of opened) ctx.close();
  stopServer(handle);
});

const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

/** A code minted by an authenticated space, exactly as the admin screen does it. */
async function mintCode(jar, { name = "Borne entrée", kind = "kiosk" } = {}) {
  const r = await raw("/api/devices/pairing", { jar, body: { name, kind } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.code;
}

/** A kiosk that keeps scanning would chain a timeout forever; the tests hand the page back. */
async function stopKiosk(ctx) {
  const start = ctx.document.getElementById("rec-start");
  if (start) { start.click(); await ctx.flush(2, 10); }
}

test("un appareil non relié reçoit l'écran de code, et rien d'autre", async () => {
  const ctx = track(await openPage("/kiosk", makeJar()));
  assert.equal(ctx.document.getElementById("view-pair").hidden, false, "l'écran d'appairage est visible");
  assert.equal(ctx.document.getElementById("view-run").hidden, true, "le kiosque lui-même reste caché tant que rien n'est relié");
  assert.match(ctx.document.getElementById("k-device").textContent, /non relié/);
  assert.equal(ctx.errors.length, 0, "page sans erreur console : " + ctx.errors.join(" | "));
  assert.deepEqual(ctx.inlineStyles, [], "aucun style en ligne injecté");
  const html = readFileSync(join(SITE, "kiosk.html"), "utf8");
  assert.equal(/\sstyle=/.test(html), false, "le HTML du kiosque non plus ne pose pas de style en ligne");
  assert.match(html, /<meta name="viewport"/, "une borne est lue de loin : la page est prévue pour le plein écran");
  assert.match(html, /noindex/, "un kiosque ne s'indexe pas");
});

test("le lien partagé relie l'appareil tout seul", async () => {
  const { jar } = await space("fitness");
  const code = await mintCode(jar, { name: "Tablette accueil", kind: "tablet" });
  assert.match(code, CODE_RE);
  const kiosk = makeJar();
  const ctx = track(await openPage(`/kiosk?pair=${code}`, kiosk));
  await ctx.flush(8, 30);
  const doc = ctx.document;
  assert.equal(doc.getElementById("view-run").hidden, false, "le kiosque s'affiche sans un clic");
  assert.match(doc.getElementById("k-device").textContent, /Tablette accueil/, "l'appareil sait comment il a été nommé");
  assert.match(doc.getElementById("k-org").textContent, /Espace fitness/, "et à quelle entreprise il appartient");
  assert.equal(doc.getElementById("k-pair-error").textContent.trim(), "", "aucune erreur à l'écran");
  assert.equal(ctx.window.location.pathname, "/kiosk", "le code disparaît de la barre d'adresse : il ne restera pas dans l'historique");
  assert.equal(doc.getElementById("k-unpair").hidden, false, "depuis un kiosque relié, on peut en sortir");

  const listed = await raw("/api/devices", { jar });
  assert.equal(listed.data.pairings.length, 0, "le code a brûlé");
  const device = listed.data.devices.find((d) => d.name === "Tablette accueil");
  assert.ok(device, "l'appareil est dans la liste de l'entreprise");
  assert.equal(device.kind_label, "Tablette");
  assert.ok(device.online, "son dernier battement vient de l'écran de code");
  await stopKiosk(ctx);
});

test("un code recopié à la main marche aussi, en minuscules et avec des espaces", async () => {
  const { jar } = await space("canteen");
  const code = await mintCode(jar, { name: "Borne self", kind: "kiosk" });
  const kiosk = makeJar();
  const ctx = track(await openPage("/kiosk", kiosk));
  const form = ctx.document.getElementById("pair-form");
  form.elements.code.value = code.toLowerCase().split("").join(" ");
  form.requestSubmit();
  await ctx.flush(10, 30);
  assert.equal(ctx.document.getElementById("view-run").hidden, false, "relié au premier envoi");
  assert.equal((await raw("/api/devices", { jar })).data.pairings.length, 0);
  await stopKiosk(ctx);
});

test("un code faux est expliqué sur place, et ne laisse rien s'installer", async () => {
  const { jar } = await space("office");
  await mintCode(jar);
  const kiosk = makeJar();
  const ctx = track(await openPage("/kiosk", kiosk));
  const form = ctx.document.getElementById("pair-form");
  form.elements.code.value = "SANSQUATRE";
  form.requestSubmit();
  await ctx.flush(8, 30);
  assert.match(ctx.document.getElementById("k-pair-error").textContent, /6 caractères/, "le mauvais format est dit avant même d'appeler le serveur");
  form.elements.code.value = "ZZZZZZ";
  form.requestSubmit();
  await ctx.flush(8, 30);
  assert.match(ctx.document.getElementById("k-pair-error").textContent, /n'existe pas/);
  assert.equal(ctx.document.getElementById("view-run").hidden, true, "rien ne s'ouvre sur le kiosque");
  const listed = await raw("/api/devices", { jar });
  assert.equal(listed.data.devices.length, 0, "aucun appareil fantôme");
  assert.equal(listed.data.pairings.length, 1, "le code toujours valable attend son appareil");
});

test("le kiosque reconnaît, annonce et journalise — sans jamais sortir de son droit", async () => {
  const { jar } = await space("fitness");
  const name = "Karim " + uniq();
  const member = (await raw("/api/members", { jar, body: { name, subscription_end: today } })).data;
  const face = descriptorFor(7);
  await raw(`/api/members/${member.id}/enroll`, { jar, body: { descriptor: face, consent: true } });
  const code = await mintCode(jar, { name: "Borne hall", kind: "kiosk" });

  const kiosk = makeJar();
  const ctx = track(await openPage("/kiosk?pair=" + code, kiosk, { faceState: { loads: 0, faces: [face], box: { x: 10, y: 10, width: 300, height: 400 } } }));
  await ctx.flush(8, 30);
  const doc = ctx.document;
  assert.equal(doc.getElementById("rec-check").disabled, false, "la caméra et le moteur sont prêts");

  doc.getElementById("rec-check").click();
  await ctx.flush(10, 40);
  assert.match(doc.getElementById("rec-banner-title").textContent, /ACCÈS AUTORISÉ|BON APPÉTIT|POINTAGE/);
  assert.match(doc.getElementById("rec-banner-text").textContent, /Karim/);
  assert.equal(doc.getElementById("k-granted").textContent, "1", "le compteur du jour bouge");
  assert.ok(doc.querySelectorAll(".kiosk-log li").length >= 1, "le passage apparaît dans le fil du kiosque");

  const calls = ctx.calls.map((c) => c.path);
  assert.ok(calls.every((p) => p === "/api/pair" || p.startsWith("/api/device/")), "un kiosque n'appelle que ses propres routes : " + calls.join(", "));
  assert.equal(calls.includes("/api/state"), false, "jamais la liste des adhérents");
  assert.equal(calls.includes("/api/members"), false, "jamais l'ajout d'un adhérent depuis une borne");

  const logs = (await raw("/api/state", { jar })).data.logs;
  assert.equal(logs[0].name, name, "le nom de la personne reconnue");
  assert.equal(logs[0].device_name, "Borne hall", "l'humain au comptoir voit d'où vient le passage");
  assert.equal(logs[0].method, "Facial");
  // « Couper la caméra » reste possible, mais ne doit plus jamais laisser une borne éteinte.
  doc.getElementById("rec-start").click();
  await ctx.flush(6, 30);
  assert.match(doc.getElementById("rec-start").textContent, /Reprendre/, "le bouton devient une reprise, pas un interrupteur qu'on oublie");
  assert.match(doc.getElementById("rec-banner-text").textContent, /reprendra tout seul/i, "la pause est annoncée comme temporaire");
  assert.equal(doc.getElementById("rec-check").disabled, true, "pendant la pause, le kiosque ne vérifie plus rien");
  doc.getElementById("rec-start").click();  // reprise immédiate
  await ctx.flush(12, 40);
  assert.equal(doc.getElementById("rec-check").disabled, false, "et il repart sans qu'on reconfigure quoi que ce soit");
  assert.match(doc.getElementById("rec-banner-title").textContent, /En attente d'un visage|ACCÈS AUTORISÉ/, "le direct a repris, verdict compris");
  assert.equal(ctx.errors.length, 0, "pause et reprise sont propres : " + ctx.errors.join(" | "));
  await stopKiosk(ctx);
});

test("un kiosque dont la caméra est refusée finit par s'allumer tout seul", async () => {
  const { jar } = await space("canteen");
  const code = await mintCode(jar, { name: "Borne cuisine" });
  const ctx = track(await openPage("/kiosk?pair=" + code, makeJar(), { faceState: { loads: 0, faces: [], box: { x: 0, y: 0, width: 300, height: 400 } } }));
  await ctx.flush(8, 30);
  const doc = ctx.document;
  const cam = ctx.window.navigator.mediaDevices;
  const working = cam.getUserMedia;
  // une caméra tenue par une autre application, comme sur un poste d'accueil mal réveillé
  cam.getUserMedia = async () => { throw Object.assign(new Error("busy"), { name: "NotReadableError" }); };
  doc.getElementById("rec-start").click();     // pause
  await ctx.flush(3, 20);
  doc.getElementById("rec-start").click();     // reprise -> échec -> veilleur
  await ctx.flush(8, 30);
  assert.match(doc.getElementById("rec-banner-text").textContent, /caméra/i, "le refus est dit en clair, sans écran bloqué");
  assert.ok(doc.querySelectorAll('.toasts [data-tag="camera"]').length === 1, "une fiche prévenue — une seule fois, pas une ligne noyée dans le texte");
  assert.equal(doc.getElementById("rec-check").disabled, true, "tant que la caméra est fermée, on ne vérifie rien");
  await ctx.flush(40, 100);   // le veilleur passe à l'essai suivant, avec son compte à rebours
  assert.match(doc.getElementById("rec-banner-text").textContent, /essai dans/i, "et il annonce qu'il réessaie seul");
  // le poste se libère : personne ne reconfigure le kiosque, il se remet en marche lui-même.
  const force = [...doc.querySelectorAll('.toasts [data-tag="camera"] button')].find((b) => /R\u00e9essayer/.test(b.textContent));
  assert.ok(force, "la fiche propose de forcer le prochain essai");
  cam.getUserMedia = working;
  force.click();
  await ctx.flush(20, 40);
  assert.equal(doc.getElementById("rec-check").disabled, false, "le kiosque s'est rallumé tout seul");
  assert.match(doc.getElementById("rec-status").textContent, /visage/i, "et le poste dit où il en est, sans qu'on rouvre quoi que ce soit");
  assert.ok(doc.getElementById("rec-auto").checked, "et le mode automatique est reparti avec lui");
  assert.equal(ctx.errors.length, 0, "la convalescence est silencieuse côté console : " + ctx.errors.join(" | "));
  ctx.close();
  opened.splice(opened.indexOf(ctx), 1);   // déjà fermé : after() ne doit pas y revenir
});

test("un visage inconnu du kiosque est refusé et annoncé", async () => {
  const { jar } = await space("coworking");
  const stranger = (await raw("/api/members", { jar, body: { name: "Otto " + uniq(), subscription_end: today } })).data;
  await raw(`/api/members/${stranger.id}/enroll`, { jar, body: { descriptor: descriptorFor(3), consent: true } });
  // a face far enough from every enrolled one: matching is a distance test, so make it unambiguous
  const otherFace = Array.from({ length: 128 }, (_, i) => (i % 2 ? 0.09 : -0.09));
  const code = await mintCode(jar);
  // the face in front of the camera belongs to nobody enrolled
  const ctx = track(await openPage("/kiosk?pair=" + code, makeJar(), { faceState: { loads: 0, faces: [otherFace], box: { x: 0, y: 0, width: 300, height: 400 } } }));
  await ctx.flush(8, 30);
  ctx.document.getElementById("rec-check").click();
  await ctx.flush(10, 40);
  assert.match(ctx.document.getElementById("rec-banner-title").textContent, /VISAGE INCONNU/);
  assert.match(ctx.document.getElementById("rec-banner-text").textContent, /non reconnu/);
  // an unknown face is refused on the spot: nobody was billed, so nothing is journaled for the company
  assert.equal(ctx.document.getElementById("k-refused").textContent, "0", "le compteur de refus de l'entreprise ne bouge pas");
  assert.ok(ctx.document.querySelectorAll(".kiosk-log li").length >= 1, "la borne, elle, garde la trace de la tentative");
  assert.equal((await raw("/api/state", { jar })).data.logs.length, 0, "et un visage inconnu ne crée aucun passage");
});

test("quitter le kiosque rend l'appareil à lui-même, sans révoquer l'entreprise", async () => {
  const { jar } = await space("fitness");
  const code = await mintCode(jar, { name: "Kiosque salle" });
  const kiosk = makeJar();
  const ctx = track(await openPage("/kiosk?pair=" + code, kiosk));
  await ctx.flush(8, 30);
  assert.equal(ctx.document.getElementById("view-run").hidden, false);
  ctx.document.getElementById("k-unpair").click();
  await ctx.flush(8, 30);
  assert.equal(ctx.document.getElementById("view-pair").hidden, false, "l'écran de code revient");
  assert.match(ctx.document.getElementById("k-device").textContent, /non relié/);
  // the device row still exists: only this browser forgot the token
  const listed = await raw("/api/devices", { jar });
  assert.equal(listed.data.devices.filter((d) => d.name === "Kiosque salle").length, 1);
  assert.equal(listed.data.devices[0].revoked_at, null);
});

test("l'écran Appareils : code, QR, lien et compte à rebours", async () => {
  const { jar } = await space("office");
  const ctx = track(await openPage("/app#devices", jar));
  ctx.window.location.hash = "devices";
  await ctx.flush(6, 30);
  const doc = ctx.document;
  assert.match(doc.querySelector("#page h1").textContent, /Appareils reliés/);
  assert.match(doc.body.innerHTML, /usage unique|ne sert qu'une fois/, "le mode d'emploi tient dans l'écran");

  const form = doc.getElementById("pair-form");
  assert.ok(form, "le formulaire de code est là");
  form.elements.name.value = "Borne principal";
  form.elements.kind.value = "desk";
  form.requestSubmit();
  await ctx.flush(10, 30);

  const boxes = doc.querySelectorAll(".pair-code b");
  assert.equal(boxes.length, 6, "le code s'affiche en 6 cases, lisibles de loin");
  const code = [...boxes].map((b) => b.textContent).join("");
  assert.match(code, CODE_RE);
  assert.ok(doc.querySelector(".qr-frame svg path"), "un QR est dessiné à côté du code");
  assert.match(doc.querySelector(".pair-timer").textContent, /valable \d\d:\d\d/, "le compte à rebours tourne");
  const link = doc.querySelector(".pair-link code").textContent;
  assert.equal(link, `${BASE}/kiosk?pair=${code}`, "le lien porte exactement ce code");
  assert.match(doc.body.textContent, /Valable 10 minutes|10 minutes/, "la durée est écrite noir sur blanc");

  // and the code really works: the kiosk page pairs with it
  const kiosk = makeJar();
  const paired = await raw("/api/pair", { jar: kiosk, body: { code } });
  assert.equal(paired.status, 200, JSON.stringify(paired.data));

  // the admin board follows: the device shows up, the pending code has been spent
  ctx.window.location.hash = "overview";
  await ctx.flush(4, 30);
  ctx.window.location.hash = "devices";
  await ctx.flush(10, 30);
  const rows = [...doc.querySelectorAll("#page table tbody tr")];
  assert.ok(rows.some((r) => /Borne principal/.test(r.textContent)), "l'appareil apparaît dans « Ce qui est relié »");
  assert.equal(doc.body.textContent.includes("Borne principal — en attente"), false);
  assert.equal(ctx.errors.length, 0, "page sans erreur console : " + ctx.errors.join(" | "));
  assert.deepEqual(ctx.inlineStyles, [], "et sans style en ligne");
});

test("renommer et révoquer se font depuis ce même écran", async () => {
  const { jar } = await space("office");
  const code = await mintCode(jar, { name: "Borne à renommer" });
  const kiosk = makeJar();
  assert.equal((await raw("/api/pair", { jar: kiosk, body: { code } })).status, 200);
  assert.equal((await raw("/api/device/state", { jar: kiosk })).status, 200, "le kiosque de cet appareil tourne");
  const ctx = track(await openPage("/app#devices", jar));
  ctx.window.location.hash = "devices";
  await ctx.flush(8, 30);
  const doc = ctx.document;

  const row = [...doc.querySelectorAll("#page table tbody tr")].find((r) => /Borne à renommer/.test(r.textContent));
  assert.ok(row, "la ligne de l'appareil");
  const rename = row.querySelector('form[data-api$="/rename"]');
  rename.elements.name.value = "Borne arrière-cour";
  rename.requestSubmit();
  await ctx.flush(10, 30);
  assert.match(doc.querySelector("#page").textContent, /Borne arrière-cour/, "le nom est aussitôt remplacé");

  const revoke = doc.querySelector('[data-action="device-revoke"]');
  assert.ok(revoke, "un bouton de révocation par appareil");
  revoke.click();
  await ctx.flush(10, 30);
  const listed = await raw("/api/devices", { jar });
  const revoked = listed.data.devices.find((d) => d.name === "Borne arrière-cour");
  assert.ok(revoked.revoked_at, "révoqué : la ligne reste, le jeton meurt");
  // and the browser that was paired with it is now back in the cold
  const cold = await raw("/api/device/state", { jar: kiosk });
  assert.equal(cold.status, 401, "l'écran de code revient sur l'appareil révoqué");
  assert.equal(ctx.errors.length, 0, ctx.errors.join(" | "));
});

test("les codes en attente sont listés et annulables", async () => {
  const { jar } = await space("coworking");
  const code = await mintCode(jar, { name: "Tablette réception" });
  const ctx = track(await openPage("/app#devices", jar));
  ctx.window.location.hash = "devices";
  await ctx.flush(8, 30);
  const doc = ctx.document;
  assert.match(doc.body.textContent, new RegExp(code), "le code en attente est lisible");
  assert.match(doc.querySelector(".pair-timer").textContent, /\d/, "avec son reste de validité");
  const cancel = doc.querySelector('[data-action="pair-cancel"]');
  cancel.click();
  await ctx.flush(10, 30);
  assert.equal((await raw("/api/devices", { jar })).data.pairings.length, 0, "annulé : plus de code en attente");
  const tooLate = await raw("/api/pair", { jar: makeJar(), body: { code } });
  assert.equal(tooLate.status, 404, "et il ne marche plus");
});
