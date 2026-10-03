(function () {
  "use strict";

  const embedded = window.self !== window.top;
  const VOICE_BASE = document.body.dataset.voiceBase || "/voice/";
  const PAGES = ["overview", "members", "access", "devices", "settings"];
  const DEVICE_KINDS = [["kiosk", "Kiosque d'entrée"], ["phone", "Téléphone"], ["tablet", "Tablette"], ["desk", "Poste d'accueil"], ["box", "Boîtier / caméra"]];
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Une boucle qui « reprend dans 10 s » ne doit pas survivre à la fermeture de l'onglet :
  // chaque maillon de chaîne vérifie d'abord que la fenêtre est encore ouverte (c'est aussi ce
  // qui garde les tests courts — une page fermée qui reprogramme un minuteur ne meurt jamais).
  const alive = () => !window.closed;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  let S = null; // server state (/api/state)
  let D = null; // linked devices (/api/devices), loaded on demand
  let pendingPair = null; // the pairing code just minted, until it is used or expires
  let countdownTimer = null; // one 1-second chain paints every remaining-time cell of the board
  let page = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
  let sector = "fitness";
  let pendingCapture = null; // member id to enroll right after creation
  let shell = "";            // signature de l'ossature : ce qui impose de reconstruire la page

  // ---- Ce que l'écran regarde : période, recherche, filtre, tri, page ----------
  // Un SaaS ne demande jamais un « rafraîchir » : il se souvient de ce qu'on regardait.
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v === null || v === "" ? fallback : v; } catch (_) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, String(value)); } catch (_) { /* navigation privée, quotas : rien de grave */ } },
  };
  const PERIODS = [[1, "Aujourd'hui"], [7, "7 jours"], [30, "30 jours"], [90, "Trimestre"]];
  const PER_PAGE = 12;
  const NOTIFY_KEY = "faceid.browser";
  let days = Math.min(90, Math.max(1, Number(store.get("faceid.days", 7)) || 7));
  let head = 0;              // pointeur du direct : le dernier passage déjà annoncé, jamais deux fois
  let cameraBooted = false;  // une seule tentative d'ouverture par chargement de page
  let pollTimer = null;
  const view = { overview: { q: "", state: "all" }, access: { q: "", state: "all" }, members: { q: "", state: "all", sort: "recent", page: 1 } };

  // ---- API -----------------------------------------------------------------
  async function api(path, body, method) {
    try {
      const res = await fetch(path, {
        method: method || (body ? "POST" : "GET"),
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        credentials: "same-origin",
      });
      let data = {};
      try { data = await res.json(); } catch (_) { /* no body */ }
      if (res.status === 401 && path !== "/api/logout") { location.href = "/login"; return { ok: false, code: 401, status: "error", message: "Session expirée." }; }
      return { ok: res.ok, code: res.status, status: data.status || (res.ok ? "ok" : "error"), name: data.name || "", reason: data.reason || "", message: data.message || (res.ok ? "OK" : "Erreur " + res.status), data };
    } catch (_) {
      return { ok: false, code: 0, status: "error", name: "", message: "Serveur injoignable. Vérifiez la connexion." };
    }
  }

  // Le bandeau reste dans le DOM comme région aria (les lecteurs d'écran, et les tests, s'en
  // servent) ; à l'œil, la notification est désormais une fiche empilée en haut à droite :
  // icône métier, durée de vie, action, son — et une voix sur le kiosque.
  const flashEl = document.getElementById("flash");
  let flashTimer = null;
  function flash(message, kind, detail) {
    const tone = kind === "error" ? "error" : kind === "warn" ? "warn" : "success";
    if (flashEl) {
      flashEl.textContent = message + (detail ? " " + detail : "");
      flashEl.className = "flash sr-only flash-" + tone;
      flashEl.hidden = false;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flashEl.hidden = true; }, 6000);
    }
    Toast.show({ kind: tone, title: message, body: detail, duration: tone === "error" ? 9000 : tone === "warn" ? 7000 : 4600, sound: tone !== "success" });
  }

  // La barre du haut, toujours visible, dit si la caméra de ce poste tourne : c'est la santé
  // du produit, et elle ne doit pas demander d'aller chercher l'onglet « Contrôle d'accès ».
  function syncBar(on, note) {
    const pill = document.getElementById("bar-cam");
    if (!pill) return;
    const dot = pill.querySelector(".dot-live");
    if (dot) dot.classList.toggle("on", Boolean(on));
    const label = document.getElementById("bar-cam-text");
    if (label) label.textContent = on ? "Caméra active" : (note || "Caméra en pause");
    pill.title = on ? "La caméra de ce poste analyse les visages en continu. Cliquez pour voir le direct." : (note || "La caméra de ce poste est en pause — elle se relance seule.");
  }
  const barSound = document.getElementById("bar-sound");
  if (barSound) {
    const paintSound = () => { const m = Toast.muted(); barSound.textContent = m ? "🔕 Sons coupés" : "🔔 Sons"; barSound.setAttribute("aria-pressed", String(!m)); };
    paintSound();
    barSound.addEventListener("click", () => { Toast.muted(!Toast.muted()); paintSound(); if (!Toast.muted()) { Toast.unlock(); Toast.show({ kind: "info", title: "Sons de notification réactivés", body: "Chaque passage, chaque appareil relié et chaque incident se font entendre.", duration: 3000 }); } });
  }
  const barCam = document.getElementById("bar-cam");
  if (barCam) barCam.addEventListener("click", () => { location.hash = "access"; });
  // Un navigateur n'autorise un son qu'après un geste : on le capte une fois, sans le réclamer.
  ["pointerdown", "keydown"].forEach((evt) => window.addEventListener(evt, () => Toast.unlock(), { once: true, passive: true }));

  function notify(title, body) {
    if (store.get(NOTIFY_KEY, "on") === "off" || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try { new Notification(title, { body: body || "", tag: "faceid-" + title }); } catch (_) { /* refusé sans service worker : les fiches suffisent */ }
  }

  // ---- Voice announcements (free: browser French female voice, else recorded clips) ----
  const GRANTED = {
    fitness: (n) => (n ? "Bienvenue " + n + ". Accès autorisé." : "Accès autorisé. Bienvenue !"),
    coworking: (n) => (n ? "Bienvenue " + n + ". Accès autorisé." : "Accès autorisé. Bienvenue !"),
    office: (n) => (n ? "Bonjour " + n + ". Pointage enregistré." : "Pointage enregistré. Bonne journée."),
    canteen: (n) => (n ? "Bon appétit " + n + " !" : "Repas enregistré. Bon appétit !"),
  };
  const EXPIRED_WORD = { fitness: "abonnement", coworking: "accès payé", office: "contrat", canteen: "inscription" };
  const PHRASES = {
    granted: (n) => (GRANTED[sector] || GRANTED.fitness)(n),
    already: (n) => (n ? n + ", déjà enregistré aujourd'hui. Merci." : "Déjà enregistré aujourd'hui. Merci."),
    expired: (n) => "Accès refusé. " + (n ? n + ", votre " : "Votre ") + (EXPIRED_WORD[sector] || "abonnement") + " est expiré. Merci de passer à l'accueil.",
    unknown: () => "Accès refusé. Visage non reconnu.",
    far: () => "Approchez-vous de la caméra, s'il vous plaît.",
    none: () => "Placez-vous face à la caméra.",
    multi: () => "Une seule personne à la fois, s'il vous plaît.",
    camera_on: () => "Caméra activée. Permission accordée.",
    camera_denied: () => "Permission caméra refusée. Vérifiez les autorisations du navigateur.",
    auto_on: () => "Mode automatique activé. Présentez-vous devant la caméra.",
    auto_off: () => "Mode automatique désactivé.",
    camera_off: () => "Caméra désactivée.",
    enrolled: () => "Visage enregistré avec succès.",
    voice_on: () => "Annonces vocales activées.",
  };
  const CLIPS = ["granted", "already", "expired", "unknown", "far", "none", "multi", "camera_on", "camera_denied", "auto_on", "enrolled", "pointage", "meal"];
  const CLIP_FOR = { granted: { office: "pointage", canteen: "meal" } };
  const FEMALE_VOICES = ["google français", "denise", "hortense", "julie", "audrey", "amélie", "amelie", "vivienne", "eloise", "éloise", "aurélie", "aurelie", "charlotte", "marie", "pauline", "sylvie", "céline", "celine", "chantal", "virginie", "léa", "coralie", "jacqueline", "brigitte", "female", "femme"];
  const HINTS = ["far", "none", "multi"];
  const clipPlayer = new Audio();
  const lastSpoken = new Map();
  let voiceOn = localStorage.getItem("faceid.voice") !== "off";
  let ttsBusyUntil = 0;

  const busySpeaking = () => Date.now() < ttsBusyUntil || (!clipPlayer.paused && !clipPlayer.ended);
  function pickVoice() {
    if (!("speechSynthesis" in window)) return null;
    const fr = speechSynthesis.getVoices().filter((v) => /^fr/i.test(v.lang));
    for (const key of FEMALE_VOICES) { const m = fr.find((v) => v.name.toLowerCase().includes(key)); if (m) return m; }
    return null;
  }
  function voiceLabel() {
    if (!voiceOn) return "Annonces vocales désactivées.";
    const v = pickVoice();
    return v ? "Voix : " + v.name + " (synthèse vocale gratuite du navigateur)." : "Voix : enregistrée (le navigateur n'a pas de voix féminine française).";
  }
  function refreshVoiceInfo() {
    document.querySelectorAll(".js-voice-info").forEach((el) => { el.textContent = voiceLabel(); });
    document.querySelectorAll(".js-voice-toggle").forEach((btn) => { btn.textContent = voiceOn ? "🔊 Voix" : "🔇 Voix coupée"; btn.setAttribute("aria-pressed", String(voiceOn)); });
  }
  function speak(key, name, minGapMs) {
    if (!voiceOn || !PHRASES[key]) return;
    if (HINTS.includes(key) && busySpeaking()) return;
    const id = key + "|" + (name || "");
    const now = Date.now();
    if (minGapMs && lastSpoken.has(id) && now - lastSpoken.get(id) < minGapMs) return;
    lastSpoken.set(id, now);
    const voice = pickVoice();
    if (voice) {
      speechSynthesis.cancel();
      const text = PHRASES[key](name);
      const u = new SpeechSynthesisUtterance(text);
      u.voice = voice; u.lang = voice.lang; u.rate = 1; u.pitch = 1;
      ttsBusyUntil = now + Math.min(8000, 500 + text.length * 75);
      u.onend = u.onerror = () => { ttsBusyUntil = 0; };
      speechSynthesis.speak(u);
    } else if (CLIPS.includes(key)) {
      const clip = (CLIP_FOR[key] && CLIP_FOR[key][sector]) || key;
      clipPlayer.pause(); clipPlayer.src = VOICE_BASE + clip + ".mp3"; clipPlayer.currentTime = 0;
      clipPlayer.play().catch(() => {});
    }
  }
  function speakResult(result) {
    const gap = 8000;
    if (result.status === "granted") speak("granted", result.name, gap);
    else if (result.status === "already") speak("already", result.name, gap);
    else if (result.status === "expired") speak("expired", result.name, gap);
    else if (result.status === "unknown") speak("unknown", "", gap);
    else if (result.status === "no_face") speak(result.reason === "far" ? "far" : "none", "", 12000);
    else if (result.status === "multi_face") speak("multi", "", 8000);
  }
  function toggleVoice() {
    voiceOn = !voiceOn;
    localStorage.setItem("faceid.voice", voiceOn ? "on" : "off");
    if (!voiceOn) { if ("speechSynthesis" in window) speechSynthesis.cancel(); clipPlayer.pause(); }
    refreshVoiceInfo();
    if (voiceOn) speak("voice_on");
  }
  if ("speechSynthesis" in window) speechSynthesis.addEventListener("voiceschanged", refreshVoiceInfo);
  window.addEventListener("pagehide", () => { if ("speechSynthesis" in window) speechSynthesis.cancel(); });

  // ---- Camera helpers --------------------------------------------------------
  function setStatus(el, text, kind) { if (el) { el.textContent = text; el.className = "status" + (kind ? " " + kind : ""); } }
  function cameraHelp(el, err) {
    let text;
    if (!window.isSecureContext) text = "La caméra exige une connexion HTTPS (ou http://localhost).";
    else if (err && (err.name === "NotFoundError" || err.name === "OverconstrainedError")) text = "Aucune caméra détectée sur cet appareil.";
    else if (err && err.name === "NotReadableError") text = "La caméra est déjà utilisée par une autre application.";
    else if (embedded) text = "Le navigateur bloque la caméra dans cette fenêtre intégrée.";
    else text = "Accès caméra refusé : autorisez la caméra dans la barre d'adresse puis réessayez.";
    setStatus(el, text + " ", "error");
    if (embedded) { const a = document.createElement("a"); a.href = location.href; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Ouvrir la plateforme dans un nouvel onglet →"; el.appendChild(a); }
  }
  async function startCamera(video, statusEl) {
    if (!navigator.mediaDevices?.getUserMedia) { cameraHelp(statusEl, null); return null; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      video.srcObject = stream;
      await video.play().catch(() => {});
      return stream;
    } catch (err) { cameraHelp(statusEl, err); return null; }
  }
  function stopCamera(video) { const s = video && video.srcObject; if (s) s.getTracks().forEach((t) => t.stop()); if (video) video.srcObject = null; }
  function hintMessage(face) {
    if (face.status === "multi_face") return "Plusieurs visages détectés : une personne à la fois.";
    return face.reason === "far" ? "Approchez-vous de la caméra." : "Placez le visage au centre de l'image.";
  }

  // ---- Rendering -------------------------------------------------------------
  const sec = () => S.sector;
  const badge = (end) => (end >= S.today ? '<span class="badge badge-ok">Actif</span>' : '<span class="badge badge-warn">Expiré</span>');
  // Le surlignage du terme cherché : le texte échappé d'abord, l'index trouvé sur l'original.
  function hl(text, needle) {
    const t = String(text ?? "");
    const n = String(needle || "").trim();
    if (!n) return esc(t);
    const i = t.toLowerCase().indexOf(n.toLowerCase());
    if (i < 0) return esc(t);
    return esc(t.slice(0, i)) + "<mark>" + esc(t.slice(i, i + n.length)) + "</mark>" + esc(t.slice(i + n.length));
  }
  const periodTabs = () => `<div class="tabs" role="group" aria-label="Période observée">` +
    PERIODS.map(([d, label]) => `<button type="button" data-action="period" data-days="${d}" aria-pressed="${d === days ? "true" : "false"}">${label}</button>`).join("") + "</div>";
  const chipSet = (name, current, items) => `<div class="filters" role="group" aria-label="Filtres">` +
    items.map(([v, label]) => `<button type="button" class="chip" data-action="filter" data-target="${name}" data-value="${v}" aria-pressed="${v === current ? "true" : "false"}">${label}</button>`).join("") + "</div>";
  const searchBox = (name, placeholder) => `<span class="search"><input type="search" data-action="search" data-target="${name}" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" autocomplete="off" value="${esc(view[name].q)}"></span>`;
  const csvButton = `<button class="btn btn-ghost btn-sm" type="button" data-action="export-csv" title="Télécharger la période affichée en CSV (Excel, Numbers, Sheets)">⬇ Exporter</button>`;
  const clock = () => new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  // Une ligne de journal, la même partout : tableau complet ou fil du direct.
  function passageRow(l, needle) {
    const s = sec();
    const ok = l.status === "granted";
    return `<tr><td>${hl(l.name, needle)}</td><td class="muted">${esc(l.method)}</td><td>${ok ? `<span class="badge badge-ok">${s.rule === "attendance" ? "Pointé" : "Autorisé"}</span>` : '<span class="badge badge-warn">Refusé</span>'}${l.late ? ' <span class="badge badge-late">Retard</span>' : ""}</td><td>${esc(l.local_time || "—")}</td><td class="muted">${esc(l.local_date)}</td><td class="muted">${esc(l.device_name || "ce poste")}</td></tr>`;
  }
  function journalTable(rows, needle) {
    const s = sec();
    if (!rows.length) return `<p class="empty"><strong>Aucun ${esc(s.entry.toLowerCase())} sur cette période.</strong>Dès qu'un visage passe devant une caméra — ici ou sur un kiosque relié — la ligne apparaît sans rechargement.</p>`;
    return `<table class="sticky"><thead><tr><th>${esc(cap(s.person))}</th><th>Méthode</th><th>Résultat</th><th>Heure</th><th>Date</th><th>Poste</th></tr></thead><tbody>` + rows.map((l) => passageRow(l, needle)).join("") + "</tbody></table>";
  }
  function scopedLogs(where) {
    const v = view[where];
    const needle = v.q.trim().toLowerCase();
    let rows = S.logs.filter((l) => {
      if (v.state === "granted" && l.status !== "granted") return false;
      if (v.state === "refused" && l.status === "granted") return false;
      if (v.state === "late" && !l.late) return false;
      if (needle && !(String(l.name).toLowerCase().includes(needle) || String(l.device_name || "").toLowerCase().includes(needle))) return false;
      return true;
    });
    return rows;
  }
  // Le même bloc journal partout : la page décide quelles colonnes et quel nombre de lignes.
  const journalWhere = () => (page === "access" ? "access" : "overview");
  // Le titre et la barre d'outils sont fixes (on n'efface jamais une saisie en cours) ; seule la
  // zone data-live est repeinte par le direct, la recherche et les filtres.
  function journalCard(id) {
    return `<section class="card"><div class="card-head"><h2>Journal des ${esc(sec().entries.toLowerCase())}</h2><button class="btn btn-link btn-sm" type="button" data-action="journal-help">comment lire ce tableau&nbsp;?</button></div>${toolbar(journalWhere())}<div${id ? ` id="${id}"` : ""} data-live="journal">${journalPanel()}</div></section>`;
  }
  function journalPanel() {
    const where = journalWhere();
    const v = view[where];
    const rows = scopedLogs(where);
    const shown = where === "overview" ? rows.slice(0, 8) : rows;
    return `<p class="muted small">${rows.length} ligne(s) affichée(s) sur ${S.logs.length} lues${days === 1 ? "" : " · " + days + " jours"}${v.q ? " · recherche : « " + esc(v.q.trim()) + " »" : ""}</p>` + journalTable(shown, v.q.trim());
  }
  function toolbar(where) {
    const v = view[where];
    return `<div class="toolbar">${searchBox(where, where === "members" ? "Rechercher un nom ou un email…" : "Rechercher un nom, un poste…")}${chipSet(where === "members" ? "members" : "access", v.state, where === "members"
      ? [["all", "Tous"], ["active", "Actifs"], ["expired", "Expirés"], ["enrolled", "Visage pris"], ["missing", "Sans visage"]]
      : [["all", "Tous"], ["granted", "Autorisés"], ["refused", "Refusés"], ["late", "Retards"]])}${where === "access" ? csvButton : ""}</div>`;
  }

  function kpisHtml() {
    return S.kpis.map(([label, value, tone]) => `<div class="stat"><span class="stat-label">${esc(label)}</span><span class="stat-value ${tone}">${esc(value)}</span></div>`).join("");
  }
  function chartHtml() {
    const max = Math.max(1, ...S.chart.map((c) => c.count));
    const p = S.period || {};
    let html = `<h2>${esc(sec().entries)} — ${esc(days === 1 ? "aujourd'hui" : days + " jours")}</h2><div class="chart">` +
      S.chart.map((c) => `<div class="bar-wrap"><div class="bar" data-height="${Math.round((c.count / max) * 100)}"><span>${c.count}</span></div><small>${esc(c.day)}</small></div>`).join("") + "</div>";
    if (p.granted !== undefined) {
      html += `<p class="muted small">${p.granted} autorisé(s) · ${p.refused} refus(s) · ${p.people} personne(s) distinctes${p.late ? " · " + p.late + " retard(s)" : ""} · ${esc(p.from)} → ${esc(p.to)}</p>`;
    }
    return html;
  }
  // Le tableau de bord doit dire quoi faire ensuite, pas seulement ce qui s'est passé.
  function stepsHtml() {
    const s = sec();
    const enrolled = S.members.filter((m) => m.enrolled).length;
    const devices = (S.devices && S.devices.count) || 0;
    const online = (S.devices && S.devices.online) || 0;
    const steps = [
      { t: cap(s.people), note: S.members.length ? S.members.length + "-enregistré(s) dans l'espace." : "Ajoutez la première personne : nom, date d'accès, visage.", href: "members", cta: "Ajouter", done: S.members.length > 0 },
      { t: "Visages", note: enrolled ? enrolled + " empreinte(s) enregistrée(s), effaçables à tout moment." : "Aucun visage capturé : sans empreinte, la reconnaissance refuse tout le monde.", href: "members", cta: "Capturer", done: enrolled > 0 },
      { t: "Postes reliés", note: devices ? devices + " appareil(s) dont " + online + " en ligne." : "Un téléphone, une tablette ou une borne peuvent reconnaître à l'entrée avec un code.", href: "devices", cta: "Générer un code", done: devices > 0 },
      { t: "Caméra de ce poste", note: dock.running() ? "Active : ce navigateur analyse les visages en continu." : "En pause d'une minute ; elle se relance seule, sans clic.", href: "access", cta: "Ouvrir le direct", done: dock.running() },
    ];
    return `<div class="card-head"><h2>Mise en route</h2><span class="muted small">Ce qui reste à faire, dans l'ordre</span></div><div class="steps-board">` +
      steps.map((st, i) => `<div class="step-item ${st.done ? "done" : ""}"><span class="mark">${st.done ? "✓" : i + 1}</span><div><strong>${esc(st.t)}</strong><span class="muted">${esc(st.note)}</span></div>${st.done ? "" : `<button class="btn btn-link btn-sm" type="button" data-action="goto" data-goto="${st.href}">${esc(st.cta)} →</button>`}</div>`).join("") + "</div>";
  }
  function attendanceHtml() {
    const s = sec();
    let html = `<h2>Présences du jour <span class="muted small">— début ${esc(S.org.work_start)}, tolérance ${esc(S.org.late_tolerance)} min</span></h2>`;
    html += S.attendance.length
      ? `<table><thead><tr><th>Employé</th><th>Arrivée</th><th>Statut</th></tr></thead><tbody>${S.attendance.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.arrival || "—")}</td><td>${a.arrival ? '<span class="badge badge-ok">Présent</span>' + (a.late ? ' <span class="badge badge-late">En retard</span>' : "") : '<span class="badge badge-warn">Absent</span>'}</td></tr>`).join("")}</tbody></table>`
      : `<p class="muted">Ajoutez vos ${esc(s.people)} pour suivre les présences.</p>`;
    return html;
  }
  // Le fil du direct : la partie se joue ici, pas après un F5.
  function liveStripHtml() {
    const rows = S.logs.slice(0, 6);
    let html = `<div class="card-head"><h2>En direct <span class="badge badge-live">live</span></h2><span class="muted small">passage suivant = fiche sonore dans la seconde</span></div>`;
    if (!rows.length) return html + `<p class="muted">Rien pour l'instant. Placez-vous devant la caméra de ce poste, ou reliez une borne à l'entrée.</p>`;
    return html + `<ul class="live-list">` + rows.map((l) => `<li class="live-${l.status === "granted" ? "granted" : "expired"}">${esc(l.local_time || clock())} — <b>${esc(l.name)}</b> — ${l.status === "granted" ? esc(sec().rule === "attendance" ? "pointé(e)" : "autorisé(e)") : "refusé(e)"} · ${esc(l.device_name || "ce poste")}</li>`).join("") + "</ul>";
  }

  function renderOverview() {
    const s = sec();
    const next = s.rule === "attendance"
      ? { href: "#access", label: "Voir les présences du jour" }
      : { href: "#members", label: "Ajouter un·e " + s.person };
    let html = `<div class="page-head"><h1>Tableau de bord</h1><span class="muted small">${esc(s.label)} · journée du ${esc(S.today)} · ${esc(S.org.timezone)} · ${S.devices ? S.devices.online + " poste(s) en ligne" : "aucun poste relié"}</span>${periodTabs()}<a class="btn btn-ghost btn-sm" href="${next.href}">${esc(next.label)}</a></div>`;
    html += `<section class="card" data-live="steps">${stepsHtml()}</section>`;
    html += `<div class="stats" data-live="kpis">${kpisHtml()}</div>`;
    html += `<div id="dock-slot"></div>`;
    html += `<div class="two-cols"><section class="card" data-live="chart">${chartHtml()}</section>`;
    html += `<section class="card" data-live="today">${liveStripHtml()}</section></div>`;
    if (s.rule === "attendance") html += `<section class="card" data-live="attendance">${attendanceHtml()}</section>`;
    html += journalCard();
    return html;
  }

  function memberRows() {
    const v = view.members;
    const needle = v.q.trim().toLowerCase();
    let rows = S.members.filter((m) => {
      const active = m.subscription_end >= S.today;
      if (v.state === "active" && !active) return false;
      if (v.state === "expired" && active) return false;
      if (v.state === "enrolled" && !m.enrolled) return false;
      if (v.state === "missing" && m.enrolled) return false;
      if (needle && !(String(m.name).toLowerCase().includes(needle) || String(m.email || "").toLowerCase().includes(needle))) return false;
      return true;
    });
    const key = (m) => (v.sort === "name" ? String(m.name).toLowerCase() : v.sort === "expiry" ? m.subscription_end : String(m.last_today || m.subscription_end));
    rows = rows.slice().sort((a, b) => (v.sort === "name" || v.sort === "expiry") ? String(key(a)).localeCompare(String(key(b))) : String(key(b)).localeCompare(String(key(a))));
    const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
    if (v.page > pages) v.page = pages;
    const slice = rows.slice((v.page - 1) * PER_PAGE, v.page * PER_PAGE);
    const s = sec();
    let html = "";
    if (!rows.length) {
      html += `<p class="empty"><strong>${S.members.length ? "Aucun résultat avec ce filtre." : "Aucun " + esc(s.person) + "."}</strong>${S.members.length ? "Changez de filtre ou videz la recherche." : "Ajoutez le premier ci-dessus : nom, date d'accès, un coup d'œil à la caméra."}</p>`;
    } else {
      html += `<table><thead><tr><th>Nom</th><th>Email</th><th>${esc(s.access)} jusqu'au</th><th>Statut</th><th>Dernier passage aujourd'hui</th><th>Visage</th><th>Actions</th></tr></thead><tbody>` +
        slice.map((m) => `<tr>
          <td>${hl(m.name, v.q)}</td><td class="muted">${m.email ? hl(m.email, v.q) : "—"}</td><td>${esc(m.subscription_end)}</td><td>${badge(m.subscription_end)}</td>
          <td>${m.last_today ? '<span class="badge badge-ok">' + esc(m.last_today) + "</span>" : '<span class="muted">—</span>'}</td>
          <td>${m.enrolled ? `<span class="badge badge-info">Enregistré</span> <button class="btn btn-link btn-sm" type="button" data-action="revoke" data-id="${m.id}">Effacer</button>` : `<button class="btn btn-ghost btn-sm" type="button" data-action="enroll" data-id="${m.id}" data-name="${esc(m.name)}">📷 Capturer</button>`}</td>
          <td class="actions">
            <form class="inline" data-api="/api/members/${m.id}/renew"><input type="date" name="subscription_end" required value="${esc(m.subscription_end)}"><button class="btn btn-ghost btn-sm" type="submit">Renouveler</button></form>
            <button class="btn btn-danger btn-sm" type="button" data-action="delete" data-id="${m.id}" data-name="${esc(m.name)}">Supprimer</button>
          </td></tr>`).join("") + "</tbody></table>";
      html += `<div class="pager"><button class="btn btn-ghost btn-sm" type="button" data-action="pager" data-target="members" data-page="${v.page - 1}" ${v.page === 1 ? "disabled" : ""}>←</button><span>${v.page} / ${pages} · ${rows.length} ${esc(s.people)}</span><button class="btn btn-ghost btn-sm" type="button" data-action="pager" data-target="members" data-page="${v.page + 1}" ${v.page === pages ? "disabled" : ""}>→</button></div>`;
    }
    return html;
  }

  function renderMembers() {
    const s = sec();
    const active = S.members.filter((m) => m.subscription_end >= S.today).length;
    const enrolled = S.members.filter((m) => m.enrolled).length;
    let html = `<div class="page-head"><h1>${esc(cap(s.people))}</h1><span class="muted small">${S.members.length} ${esc(s.people)}, ${active} avec ${esc(s.access).toLowerCase()} actif(ve), ${enrolled} visage(s) enregistré(s)</span>${csvButton}</div>
      <section class="card"><h2>Ajouter un ${esc(s.person)}</h2>
        <p class="muted small">Tapez le nom, cliquez sur « Ajouter et capturer » : la personne regarde la caméra une seconde, c'est enregistré.</p>
        <form class="inline-form" data-api="/api/members" id="add-member-form">
          <input name="name" required maxlength="100" placeholder="Nom complet" autofocus>
          <input type="email" name="email" maxlength="254" placeholder="Email (optionnel)">
          <span class="date-group">
            <input type="date" id="new-end" name="subscription_end" required value="${esc(S.today)}" title="${esc(s.access)} jusqu'au">
            <span class="quick-dates" data-target="new-end">
              <button type="button" class="chip" data-days="0">Journée</button>
              <button type="button" class="chip" data-months="1">1 mois</button>
              <button type="button" class="chip" data-months="3">3 mois</button>
              <button type="button" class="chip" data-months="12">1 an</button>
            </span>
          </span>
          <button class="btn btn-primary" type="submit" data-capture="1">📷 Ajouter et capturer</button>
          <button class="btn btn-ghost" type="submit">Ajouter sans visage</button>
        </form>
      </section>
      <section class="card"><div class="card-head"><h2>Liste (${S.members.length})</h2><label class="muted small">Tri
        <select data-action="sort" aria-label="Trier la liste">
          <option value="recent" ${view.members.sort === "recent" ? "selected" : ""}>Passages récents d'abord</option>
          <option value="name" ${view.members.sort === "name" ? "selected" : ""}>Nom A→Z</option>
          <option value="expiry" ${view.members.sort === "expiry" ? "selected" : ""}>Fin d'accès</option>
        </select></label></div>
        <div class="toolbar">${searchBox("members", "Rechercher un nom ou un email…")}${chipSet("members", view.members.state, [["all", "Tous"], ["active", "Actifs"], ["expired", "Expirés"], ["enrolled", "Visage pris"], ["missing", "Sans visage"]])}</div>
        <div data-live="members">${memberRows()}</div>
      </section>`;
    return html;
  }

  function manualList() {
    const s = sec();
    if (!S.members.length) return `<p class="muted">Ajoutez d'abord des ${esc(s.people)}.</p>`;
    return `<ul class="member-list">${S.members.map((m) => `<li><span>${esc(m.name)} ${badge(m.subscription_end)}${m.last_today ? ` <span class="muted small">vu(e) à ${esc(m.last_today)}</span>` : ""}</span><button class="btn btn-ghost btn-sm" type="button" data-action="entry" data-id="${m.id}" ${m.subscription_end < S.today ? "disabled" : ""}>Valider</button></li>`).join("")}</ul>`;
  }

  function renderAccess() {
    const s = sec();
    const rule = s.rule === "attendance" ? "le pointage est horodaté et les retards calculés" : s.rule === "one_per_day" ? "un seul repas par personne et par jour" : "l'accès est contrôlé selon la date payée";
    return `<div class="page-head"><h1>${s.rule === "attendance" ? "Pointage" : "Contrôle d'accès"}</h1><span class="muted small">La caméra de ce poste tourne en permanence : ${esc(rule)}. ${S.devices ? S.devices.online + " poste(s) en ligne" : ""}.</span>${periodTabs()}<a class="btn btn-ghost btn-sm" href="#devices">Relier un appareil</a></div>
      <div id="dock-slot"></div>
      <div class="two-cols">
        <section class="card"><h2>${esc(s.manual)}</h2><p class="muted small">Sans caméra : sélectionnez la personne et validez.</p><div data-live="manual">${manualList()}</div></section>
        <section class="card" data-live="today">${liveStripHtml()}</section>
      </div>
      ${journalCard("access-journal")}`;
  }

  async function loadDevices() {
    const r = await api("/api/devices");
    if (!r.ok) { if (r.code !== 401) flash(r.message, "error"); return; }
    D = r.data;
    if (page === "devices") render();
  }

  function deviceRows(devices) {
    if (!devices.length) return `<div class="empty"><strong>Aucun appareil relié</strong>Générez un code ci-dessus pour transformer un téléphone, une tablette ou un PC en kiosque d'entrée.</div>`;
    return `<table><thead><tr><th>Appareil</th><th>Type</th><th>Dernière activité</th><th>Actions</th></tr></thead><tbody>` +
      devices.map((d) => `<tr class="${d.online ? "is-online" : ""}">
        <td><span class="device-dot"></span>${esc(d.name)}${d.online ? ' <span class="badge badge-live">en ligne</span>' : ""}</td>
        <td class="muted">${esc(d.kind_label)}</td>
        <td class="muted small">${d.last_seen_at ? esc(new Date(d.last_seen_at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })) : "jamais"}</td>
        <td class="actions">
          <form class="inline" data-api="/api/devices/${d.id}/rename"><input name="name" required maxlength="60" value="${esc(d.name)}" aria-label="Nouveau nom"><button class="btn btn-ghost btn-sm" type="submit">Renommer</button></form>
          <button class="btn btn-danger btn-sm" type="button" data-action="device-revoke" data-device="${d.id}" data-name="${esc(d.name)}">Révoquer</button>
        </td></tr>`).join("") + "</tbody></table>";
  }

  function pairingRows(pairings) {
    if (!pairings.length) return "";
    return `<table><thead><tr><th>Code</th><th>Appareil visé</th><th>Valable</th><th></th></tr></thead><tbody>` +
      pairings.map((p) => `<tr>
        <td class="mono"><strong>${esc(p.code)}</strong></td>
        <td>${esc(p.name)} <span class="muted small">— ${esc(p.kind_label)}</span></td>
        <td class="pair-timer" data-expires="${p.expires_at}" aria-live="off">…</td>
        <td class="actions"><button class="btn btn-link btn-sm" type="button" data-action="pair-cancel" data-code="${esc(p.code)}">Annuler</button></td>
      </tr>`).join("") + "</tbody></table>";
  }

  function renderDevices() {
    const origin = location.origin;
    const link = origin + "/kiosk";
    return `<div class="page-head"><h1>Appareils reliés</h1><span class="muted small">Un kiosque sur n'importe quel écran à l'entrée</span></div>
      <section class="card">
        <div class="card-head"><h2>Relier un appareil</h2>
          <p class="muted small">Un code à usage unique, valable 10 minutes. Sur l'autre appareil, ouvrez <code>${esc(link)}</code> et saisissez-le : le kiosque ne saura que reconnaître un visage et journaliser un passage — ni vos listes, ni vos abonnements, ni vos réglages.</p>
        </div>
        <form class="inline-form" id="pair-form">
          <label>Nom de l'appareil<input name="name" required minlength="2" maxlength="60" placeholder="Borne entrée, Tablette accueil…" autocomplete="off"></label>
          <label>Type de matériel
            <select name="kind">${DEVICE_KINDS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select>
          </label>
          <button class="btn btn-primary" type="submit">Générer le code</button>
        </form>
        <div id="pair-result"></div>
      </section>
      ${D.pairings.length ? `<section class="card"><div class="card-head"><h2>Codes en attente (${D.pairings.length})</h2></div>${pairingRows(D.pairings)}</section>` : ""}
      <section class="card"><div class="card-head"><h2>Ce qui est relié (${D.devices.length})</h2></div>${deviceRows(D.devices)}</section>
      <section class="card card-quiet">
        <div class="card-head"><h2>Caméra réseau ou boîtier sans navigateur</h2></div>
        <p class="muted small">Une page web ne sait pas lire un flux RTSP, et une caméra refuse les requêtes venues d'un autre site (CORS). Le chemin fiable : un petit relais sur place — Raspberry Pi, mini-PC, le NAS de l'entreprise — détecte le visage et envoie la décision à l'API avec le jeton de l'appareil.</p>
        <pre><code>curl -s -X POST ${esc(origin)}/api/pair \\
  -H 'Content-Type: application/json' -d '{"code":"ABK7QD","kind":"box"}'   # → {"token":"…"}

FACEID_TOKEN=… curl -s -X POST ${esc(origin)}/api/device/recognized \\
  -H "Authorization: Bearer $FACEID_TOKEN" -H 'Content-Type: application/json' \\
  -d '{"member_id":12,"distance":0.31}'</code></pre>
        <p class="muted small">Le relais prêt à l'emploi est dans <code>tools/kiosk-relay.py</code> ; il prend en charge la caméra USB et les instantanés HTTP d'une caméra IP. Le jeton n'est affiché qu'une fois, au moment de l'appairage : en cas de perte, révoquez l'appareil et générez un nouveau code.</p>
      </section>`;
  }

  // --- the pairing sheet: code boxes, QR, countdown, copy/print ---
  function qrSvg(text) {
    if (typeof window.qrcode !== "function") return null;
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
    svg.setAttribute("width", String(n));
    svg.setAttribute("height", String(n));
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Code QR menant au kiosque, code d'appairage inclus");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
    return svg;
  }

  function paintPairing() {
    const box = document.getElementById("pair-result");
    if (!box) return;
    if (!pendingPair) { box.innerHTML = ""; return; }
    const { code, name, link, expiresAt } = pendingPair;
    box.textContent = "";
    const wrap = document.createElement("div");
    wrap.className = "pair-grid";
    wrap.style.marginTop = "1rem";
    wrap.style.paddingTop = "1rem";
    wrap.style.borderTop = "1px solid var(--border)";
    const left = document.createElement("div");
    left.innerHTML = `<h2>${esc(name)} — à saisir sur l'appareil</h2>
      <div class="pair-code">${code.split("").map((ch) => `<b>${ch}</b>`).join("")}</div>
      <p class="pair-link"><code>${esc(link)}</code><button class="btn btn-ghost btn-sm" type="button" data-action="copy-link" data-copy="${esc(link)}">Copier le lien</button><button class="btn btn-link btn-sm" type="button" data-action="pair-print">Imprimer la fiche</button></p>
      <p class="pair-timer" id="pair-countdown" data-expires="${expiresAt}" data-suffix="usage unique"></p>
      <ol class="pair-steps">
        <li>Sur l'autre appareil, ouvrez ce lien (ou scannez le QR) : le kiosque s'affiche.</li>
        <li>Le code est déjà dans le lien ; sinon, tapez-le, sans majuscules compliquées.</li>
        <li>Le kiosque démarre caméra et journal des passages. Ce code ne fonctionnera plus ensuite.</li>
      </ol>`;
    const side = document.createElement("div");
    side.className = "pair-side";
    const frame = document.createElement("div");
    frame.className = "qr-frame";
    const svg = qrSvg(link);
    if (svg) frame.appendChild(svg);
    else { const p = document.createElement("p"); p.className = "muted small"; p.textContent = "QR indisponible : utilisez le lien."; frame.appendChild(p); }
    side.appendChild(frame);
    const tip = document.createElement("small");
    tip.className = "muted";
    tip.textContent = "À scanner avec l'appareil à relier";
    side.appendChild(tip);
    wrap.appendChild(left);
    wrap.appendChild(side);
    box.appendChild(wrap);
  }

  // Remaining time is a display concern: the API says when a code dies, the board counts down to
  // it. A chain of one-second timeouts rather than an interval — and it ends by itself as soon as
  // the page moves on or the last code is spent, so nothing keeps a tab (or a test run) alive.
  function paintCountdowns() {
    clearTimeout(countdownTimer);
    countdownTimer = null;
    const cells = [...document.querySelectorAll(".pair-timer[data-expires]")];
    if (!cells.length) return;
    let spent = false;
    for (const cell of cells) {
      const left = Math.max(0, Math.round((Number(cell.dataset.expires) - Date.now()) / 1000));
      const text = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
      cell.textContent = (left ? "valable " + text : "expiré") + (cell.dataset.suffix ? " — " + cell.dataset.suffix : "");
      cell.classList.toggle("urgent", left > 0 && left < 60);
      if (!left) { spent = true; if (cell.id === "pair-countdown") pendingPair = null; }
    }
    if (spent) { loadDevices(); return; } // an expired code is not worth leaving on the board
    if (!alive()) return;
    countdownTimer = setTimeout(paintCountdowns, 1000);
  }

  function renderSettings() {
    const s = sec();
    const sound = Toast.muted() ? "coupés" : "activés";
    const browser = typeof Notification === "undefined" ? "indisponible" : Notification.permission;
    return `<div class="page-head"><h1>Paramètres de l'espace</h1><span class="muted small">${esc(s.label)}</span></div>
      <section class="card"><h2>Entreprise</h2>
        <form class="stack" data-api="/api/settings">
          <label>Nom de l'entreprise<input name="company" required maxlength="100" value="${esc(S.org.name)}"></label>
          <label>Secteur (adapte le vocabulaire, les indicateurs et les règles d'accès)
            <div class="sector-cards">${Object.entries(S.sectors).map(([k, v]) => `<label><input type="radio" name="sector" value="${k}" ${k === S.org.sector ? "checked" : ""}><span>${esc(v.label)}</span><small>${esc(v.pitch)}</small></label>`).join("")}</div></label>
          <label>Fuseau horaire (horodatage des ${esc(s.entries.toLowerCase())})
            <select name="timezone">${S.timezones.map((tz) => `<option value="${tz}" ${tz === S.org.timezone ? "selected" : ""}>${tz}</option>`).join("")}</select>
            <span class="tz-clock">sur place il est <b id="tz-now" data-tz="${esc(S.org.timezone)}">…</b> <span class="muted small" id="tz-note"></span></span></label>
          <fieldset class="fieldset"><legend>Pointage (secteur PME & bureaux)</legend>
            <div class="inline-form">
              <label>Début de journée<input type="time" name="work_start" value="${esc(S.org.work_start)}" required></label>
              <label>Tolérance (minutes)<input type="number" name="late_tolerance" min="0" max="240" value="${esc(S.org.late_tolerance)}" required></label>
            </div>
            <p class="muted small">Le premier pointage du jour après « début + tolérance » est compté comme retard.</p>
          </fieldset>
          <button class="btn btn-primary" type="submit">Enregistrer</button>
        </form>
      </section>
      <section class="card"><h2>Notifications</h2>
        <p class="muted small">Ce que l'espace fait entendre et montrer quand quelque chose se passe : passage, appareil relié, caméra ou réseau en défaut.</p>
        <ul class="checklist">
          <li>Fiches empilées en haut à droite, avec le visage, l'heure, le poste et l'action utile.</li>
          <li>Sons d'interface : ${esc(sound)} — le bouton 🔔 de la barre du haut bascule le son d'un clic.</li>
          <li>Notifications système du navigateur : <b id="notify-state">${esc(browser)}</b>${browser === "default" ? ' — <button class="btn btn-link btn-sm" type="button" data-action="notify-ask">les activer</button>' : ""}</li>
          <li>Annonces vocales du kiosque (une voix féminine française, gratuite, hors ligne) : <button class="btn btn-link btn-sm js-voice-toggle" type="button" aria-pressed="true">🔊 Voix</button></li>
          <li>Le mode automatique du poste est <b>toujours activé</b> : une pause demandée à la main se lève au bout d'une minute.</li>
        </ul>
        <div class="kiosk-controls">
          <button class="btn btn-ghost btn-sm" type="button" data-action="notify-test">Tester une notification</button>
          <button class="btn btn-ghost btn-sm" type="button" data-action="camera-test">Tester la caméra de ce poste</button>
        </div>
      </section>
      <section class="card"><h2>Règles actives pour « ${esc(s.label)} »</h2>
        <ul class="checklist">
          <li>Vocabulaire : ${esc(s.people)}, ${esc(s.access.toLowerCase())}, ${esc(s.entries.toLowerCase())}.</li>
          ${s.rule === "attendance" ? "<li>Premier pointage du jour horodaté ; retard calculé selon l'heure de début et la tolérance.</li>" : ""}
          ${s.rule === "one_per_day" ? "<li>Un seul repas par personne et par jour : le deuxième passage est refusé et annoncé.</li>" : ""}
          <li>${esc(s.access)} expiré(e) = refus journalisé. Même personne reconnue deux fois en moins d'une minute = un seul enregistrement.</li>
          <li>Chaque entreprise ne voit que ses propres données ; les empreintes faciales sont calculées dans le navigateur, enregistrées avec accord et effaçables.</li>
        </ul>
      </section>
      <section class="card danger-zone"><h2>Zone sensible</h2>
        <p class="muted small">Les postes reliés (téléphones, tablettes, bornes, boîtiers) reconnaissent les visages avec leur propre jeton. Ici, on les débranche tous d'un coup — le kiosque de ce poste continue de fonctionner.</p>
        <div class="kiosk-controls">
          <button class="btn btn-danger btn-sm" type="button" data-action="revoke-all">Révoquer les ${S.devices ? S.devices.count : 0} appareil(s) relié(s)</button>
          <button class="btn btn-ghost btn-sm" type="button" data-action="export-csv">Exporter le journal (CSV)</button>
        </div>
      </section>`;
  }

  // CSP-safe chart sizing: writing `style="…"` into markup is refused by `style-src 'self'`,
  // but assigning a property on el.style is allowed. Same result, no 'unsafe-inline' needed.
  function applyBarHeights(root) {
    root.querySelectorAll(".bar[data-height]").forEach((bar) => { bar.style.height = Number(bar.dataset.height) + "%"; });
  }

  // Date math on the org's own calendar day. `new Date()` + toISOString() slides back one day
  // for every timezone east of UTC (Algeria included), which turned « Journée » into « yesterday »
  // and made a brand-new member expire on arrival; it also jumped to March 3rd after January 31st.
  function addPeriod(base, { days = 0, months = 0 }) {
    const [y, m, d] = String(base).split("-").map(Number);
    const lastDayOfMonth = new Date(Date.UTC(y, m + months, 0)).getUTCDate();
    return new Date(Date.UTC(y, m - 1 + months, Math.min(d, lastDayOfMonth) + days)).toISOString().slice(0, 10);
  }

  const pageEl = document.getElementById("page");

  // Ce que l'écran regarde, et rien d'autre : le direct ne doit jamais effacer un formulaire
  // en cours de saisie. Chaque zone vivante est peinte séparément ; une zone absente (autre
  // écran, autre secteur) déclenche le rendu complet.
  const LIVE = {
    steps: () => stepsHtml(), kpis: () => kpisHtml(), chart: () => chartHtml(), today: () => liveStripHtml(),
    journal: () => journalPanel(), members: () => memberRows(), manual: () => manualList(), attendance: () => attendanceHtml(),
  };
  const LIVES = { overview: ["steps", "kpis", "chart", "today", "journal"], members: ["members"], access: ["manual", "journal", "today"], settings: [], devices: [] };

  function paintLive(name) {
    const slot = pageEl.querySelector('[data-live="' + name + '"]');
    if (!slot) return false;
    if (document.activeElement && slot.contains(document.activeElement)) return true;   // on ne touche pas à ce que la personne est en train d'écrire
    slot.innerHTML = LIVE[name]();
    applyBarHeights(slot);
    return true;
  }
  function paint() {
    if (!S) return;
    const names = LIVES[page] || [];
    if (names.some((n) => !pageEl.querySelector('[data-live="' + n + '"]'))) { render(); return; }
    names.forEach(paintLive);
    dock.place(pageEl.querySelector("#dock-slot"), page === "access");
  }

  function render() {
    if (page !== "devices") { clearTimeout(countdownTimer); countdownTimer = null; clearTimeout(liveTimer); }
    const before = page + "|" + S.org.name + "|" + S.org.sector + "|" + S.today;
    sector = S.org.sector;
    document.body.className = "app sector-" + sector;
    document.title = S.org.name + " — FaceID Platform";
    document.getElementById("org-name").textContent = S.org.name;
    document.getElementById("org-sector").textContent = S.sector.label;
    document.getElementById("user-email").textContent = S.user.email;
    const labels = { overview: "Tableau de bord", members: cap(S.sector.people), access: S.sector.rule === "attendance" ? "Pointage" : "Contrôle d'accès", devices: "Appareils reliés", settings: "Paramètres" };
    document.querySelectorAll("#menu a").forEach((a) => { a.textContent = labels[a.dataset.page]; a.classList.toggle("active", a.dataset.page === page); });

    if (page === "devices") {
      dock.place(null);
      if (!D) { loadDevices(); return; }
      pageEl.innerHTML = renderDevices();
      paintPairing();
      paintCountdowns();
      refreshVoiceInfo();
      keepDevicesFresh();
      return;
    }
    if (shell === before && (LIVES[page] || []).length) { paint(); return; }   // le direct, sans casser la saisie en cours
    shell = before;
    dock.place(null);                    // la caméra vit dans son propre noeud : on le gare avant de réécrire la page
    pageEl.innerHTML = { overview: renderOverview, members: renderMembers, access: renderAccess, settings: renderSettings }[page]();
    applyBarHeights(pageEl);
    refreshVoiceInfo();
    dock.place(pageEl.querySelector("#dock-slot"), page === "access");
    if (page === "members" && pendingCapture) {
      const m = S.members.find((x) => x.id === pendingCapture);
      pendingCapture = null;
      if (m) enrollDialog.open(m.id, m.name);
    }
  }

  async function refresh() {
    const r = await api("/api/state?days=" + days);
    if (!r.ok) { if (r.code !== 401) flash(r.message, "error"); return; }
    S = r.data;
    head = S.head || 0;                  // le direct repart d'ici : rien ne sera annoncé deux fois
    if (page === "devices") { D = null; render(); await loadDevices(); return; }
    render();
    startLive();
    // La caméra ne se demande pas, et elle n'est pas lancée avant l'authentification : elle
    // s'ouvre dès que l'espace est chargé, quel que soit l'onglet affiché.
    if (!cameraBooted) { cameraBooted = true; dock.ensure(); }
  }

  // ---- Actions ---------------------------------------------------------------
  // Recherche, filtres, tri : la réponse est immédiate et ne repasse pas par le serveur.
  let searchTimer = null;
  pageEl.addEventListener("input", (event) => {
    const box = event.target.closest('[data-action="search"]');
    if (box) {
      const where = box.dataset.target;
      view[where].q = box.value;
      if (where === "members") { view.members.page = 1; paintLive("members"); }
      else { clearTimeout(searchTimer); searchTimer = setTimeout(() => paintLive("journal"), 160); }
      return;
    }
    const sort = event.target.closest('[data-action="sort"]');
    if (sort) { view.members.sort = sort.value; view.members.page = 1; paintLive("members"); }
  });

  pageEl.addEventListener("submit", async (event) => {
    const pairForm = event.target.closest("#pair-form");
    if (pairForm) {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(pairForm).entries());
      const btn = pairForm.querySelector("button[type=submit]");
      btn.disabled = true;
      const r = await api("/api/devices/pairing", payload);
      btn.disabled = false;
      flash(r.message, r.ok ? "success" : "error");
      if (r.ok) {
        pendingPair = { code: r.data.code, name: r.data.name, link: location.origin + r.data.link, expiresAt: Date.now() + r.data.expires_in * 1000 };
        await loadDevices();
      }
      return;
    }
    const form = event.target.closest("form[data-api]");
    if (!form) return;
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(form).entries());
    if ("late_tolerance" in payload) payload.late_tolerance = Number(payload.late_tolerance);
    const capture = event.submitter && event.submitter.dataset.capture === "1";
    const buttons = form.querySelectorAll("button");
    buttons.forEach((b) => { b.disabled = true; });
    const r = await api(form.dataset.api, payload);
    buttons.forEach((b) => { b.disabled = false; });
    flash(r.message, r.ok ? "success" : "error");
    if (!r.ok) return;
    if (form.id === "add-member-form") { form.reset(); form.querySelector("#new-end").value = S.today; if (capture) pendingCapture = r.data.id; }
    await refresh();
  });

  pageEl.addEventListener("click", async (event) => {
    const chip = event.target.closest(".quick-dates .chip");
    if (chip) {
      const input = document.getElementById(chip.closest(".quick-dates").dataset.target);
      input.value = addPeriod(S.today, { days: Number(chip.dataset.days || 0), months: Number(chip.dataset.months || 0) });
      return;
    }
    // Période, filtre, page : l'écran change d'avis tout seul, sans recharger la page.
    const tab = event.target.closest('[data-action="period"]');
    if (tab) {
      days = Math.min(90, Math.max(1, Number(tab.dataset.days) || 7));
      store.set("faceid.days", days);
      pageEl.querySelectorAll('[data-action="period"]').forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.days) === days)));
      const r = await api("/api/state?days=" + days);
      if (!r.ok) { flash(r.message, "error"); return; }
      S = r.data;
      head = Number(S.head || 0);
      paint();
      flash("Période : " + (days === 1 ? "aujourd'hui" : days + " jours"), "success", S.period.granted + " autorisé(s) et " + S.period.refused + " refus du " + S.period.from + " au " + S.period.to + ".");
      return;
    }
    const chip2 = event.target.closest('[data-action="filter"]');
    if (chip2) {
      const where = chip2.dataset.target;
      view[where].state = chip2.dataset.value;
      if (where === "members") view.members.page = 1;
      chip2.closest(".filters").querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.value === view[where].state)));
      paintLive(where === "members" ? "members" : "journal");
      return;
    }
    const pager = event.target.closest('[data-action="pager"]');
    if (pager) {
      view.members.page = Math.max(1, Number(pager.dataset.page) || 1);
      paintLive("members");
      return;
    }
    const jump = event.target.closest('[data-action="goto"]');
    if (jump) { location.hash = jump.dataset.goto; return; }
    if (event.target.closest('[data-action="journal-help"]')) {
      Toast.show({
        kind: "info", title: "Comment lire ce journal", duration: 14000, meta: sec().label,
        body: "Une ligne = une tentative devant une caméra ou un valideur manuel. « Autorisé » veut dire reconnue ET à jour de " + sec().access.toLowerCase() + ". Un refus n'est jamais une panne du système : c'est la règle de l'espace qui a protégé l'entrée.",
      });
      return;
    }
    if (event.target.closest(".js-voice-toggle")) { toggleVoice(); return; }
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    if (action === "copy-link") {
      const link = btn.dataset.copy;
      try { await navigator.clipboard.writeText(link); flash("Lien copié : ouvrez-le sur l'appareil à relier."); }
      catch (_) { flash("Copiez le lien à la main : " + link, "error"); }
      return;
    }
    if (action === "pair-print") { window.print(); return; }
    if (action === "export-csv") { await exportCsv(btn); return; }
    if (action === "notify-ask" || action === "notify-test") {
      if (typeof Notification === "undefined") { flash("Ce navigateur ne propose pas de notifications système", "warn", "Les fiches de l'espace et la voix du kiosque restent actives."); return; }
      if (action === "notify-ask") {
        let permission = Notification.permission;
        try { permission = await Notification.requestPermission(); } catch (_) { permission = Notification.permission; }
        store.set(NOTIFY_KEY, permission === "granted" ? "on" : "off");
        flash(permission === "granted" ? "Notifications système activées" : "Le navigateur refuse les notifications système ici", permission === "granted" ? "success" : "warn", permission === "granted" ? "Chaque passage préviendra l'écran, même en arrière-plan d'onglet." : "Les fiches et la voix du kiosque continuent de prévenir sur place.");
        render();
        return;
      }
      notify(sec().person + " vu(e) au poste de démonstration", "Sacha : " + (sec().rule === "attendance" ? "pointage" : "accès") + " autorisé à " + clock() + ".");
      Toast.passage({ status: "granted", name: "Sacha (test)", message: "C'est exactement ce que cette fiche affichera au prochain passage réel.", time: clock(), device: "poste de démonstration", hero: false });
      return;
    }
    if (action === "camera-test") {
      await dock.ensure(true);
      flash(dock.running() ? "Caméra de ce poste active" : "La caméra refuse encore de s'ouvrir", dock.running() ? "success" : "warn", dock.running() ? "Le mode automatique analyse à nouveau dans ce navigateur : aucune image ne sort du poste." : "Le poste réessaie seul toutes les quelques secondes ; vérifiez le petit cadenas de la barre d'adresse.");
      return;
    }
    if (action === "revoke-all") {
      if (window.confirm && !window.confirm("Révoquer tous les appareils reliés ? Leurs kiosques cessent de fonctionner immédiatement.")) return;
      const r = await api("/api/devices/revoke-all", {});
      flash(r.message, r.ok ? "success" : "error");
      if (r.ok) { D = null; await refresh(); }
      return;
    }
    if (action === "pair-cancel") {
      const r = await api("/api/devices/pairing/cancel", { code: btn.dataset.code });
      if (pendingPair && pendingPair.code === btn.dataset.code) pendingPair = null;
      await loadDevices();
      flash(r.message, r.ok ? "success" : "error");
      return;
    }
    if (action === "device-revoke") {
      if (window.confirm && !window.confirm("Révoquer « " + btn.dataset.name + " » ? Son kiosque cesse de fonctionner immédiatement.")) return;
      const r = await api("/api/devices/" + btn.dataset.device + "/revoke", {});
      await loadDevices();
      flash(r.message, r.ok ? "success" : "error");
      return;
    }
    if (action === "enroll") { enrollDialog.open(Number(id), btn.dataset.name); return; }
    if (action === "delete" && !window.confirm("Supprimer " + btn.dataset.name + " et toutes ses données ?")) return;
    btn.disabled = true;
    const r = await api("/api/members/" + id + "/" + action, {});
    btn.disabled = false;
    flash(r.message, r.ok ? "success" : "error");
    if (r.ok || r.status === "already") {
      if (action === "revoke") dock.forget(Number(id));
      await refresh();
      if (action === "delete") dock.refreshFeed();
    }
  });

  // Un clic sur « Exporter » vaut une période entière : le navigateur ne garde qu'un extrait sous
  // la main, le serveur en renvoie jusqu'à 5000 lignes, en CSV prêt pour Excel comme pour Sheets.
  async function exportCsv(btn) {
    btn.disabled = true;
    const r = await api("/api/journal?days=" + days);
    btn.disabled = false;
    if (!r.ok) { flash(r.message, "error"); return; }
    const rows = r.data.rows || [];
    if (!rows.length) { flash("Aucun " + sec().entry.toLowerCase() + " sur cette période", "warn", "Rien à exporter : le fichier serait vide."); return; }
    const body = ["date;heure;personne;methode;statut;retard;poste"].concat(rows.map((x) => [
      x.local_date, x.local_time, String(x.name || "").replace(/[;\n]/g, " "), x.method, x.status === "granted" ? "autorise" : "refuse", x.late ? "oui" : "non", x.device_name || "ce poste",
    ].join(";"))).join("\r\n");
    if (typeof Blob === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      flash("Export prêt, mais ce navigateur bloque le téléchargement local", "warn", rows.length + " lignes · " + r.data.from + " → " + r.data.to + ".");
      return;
    }
    const url = URL.createObjectURL(new Blob(["\ufeff" + body], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "faceid-" + r.data.from + "-" + r.data.to + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) { /* déjà libéré */ } }, 5000);
    flash(rows.length + " " + sec().entries.toLowerCase() + " exportés", "success", "Période " + r.data.from + " → " + r.data.to + " · " + r.data.count + " lignes lues côté serveur.");
  }

  // ---- Le direct ------------------------------------------------------------------
  // Une seule boucle douce : le serveur ne renvoie que ce qui est paru depuis le dernier pointeur,
  // donc tant que rien ne passe on ne touche à aucun pixel. Une ligne fraîche = une fiche, un son,
  // une notification système. C'est ce qui remplace le « rafraîchissez la page pour voir ».
  let clockTimer = null;
  function startLive() {
    clearTimeout(pollTimer);
    if (!S || document.hidden) return;
    if (!alive()) return;
    pollTimer = setTimeout(liveTick, 5000);
  }
  async function liveTick() {
    clearTimeout(pollTimer);
    if (!S || document.hidden || !alive()) return;
    pollTimer = setTimeout(liveTick, 5000);
    const r = await api("/api/state?days=" + days + (head ? "&since=" + head : ""));
    if (!r.ok || !r.data) return;
    const d = r.data;
    const fresh = (d.logs || []).slice().reverse();     // le serveur répond du plus récent au plus ancien
    const moved = Number(d.head || 0) !== head;
    S = Object.assign(S, { kpis: d.kpis, chart: d.chart, period: d.period, devices: d.devices, members: d.members, attendance: d.attendance, logs: moved ? S.logs.concat(fresh).slice(0, 40) : S.logs });
    paint();
    if (!moved) return;
    head = Number(d.head || 0);
    for (const row of fresh) {
      const granted = row.status === "granted";
      Toast.passage({ status: granted ? "granted" : "expired", name: row.name, message: row.message, time: row.local_time, device: row.device_name || "poste relié", person: sec().person, hero: false });
      notify((granted ? sec().person + " vu(e) au " : "Accès refusé au ") + (row.device_name || "poste relié"), row.message || "");
      speak(granted ? "granted" : "expired", row.name, 20000);
    }
  }

  // L'horloge du fuseau de l'entreprise, posée sur l'écran qui le règle : un coup d'œil suffit pour
  // vérifier que « Africa/Algiers » veut bien dire la même heure que les gens du comptoir.
  function clockTick() {
    clearTimeout(clockTimer);
    const el = pageEl.querySelector("[data-tz]");
    if (!el) return;
    let text = "";
    try { text = new Date().toLocaleTimeString("fr-FR", { timeZone: el.dataset.tz, hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch (_) { text = "—"; }
    el.textContent = text;
    const note = pageEl.querySelector("#tz-note");
    if (note) note.textContent = text === "—" ? "fuseau refusé par ce navigateur" : "le journal est horodaté sur ce fuseau";
    if (alive()) clockTimer = setTimeout(clockTick, 1000);
  }

  // The devices page is a live board: an apparatus that just came online should show up.
  // A timeout chain, not an interval — a timer that never ends would keep the page (and the
  // test runner) alive forever; this one stops as soon as we leave the page or it is hidden.
  let liveTimer = null;
  function keepDevicesFresh() {
    clearTimeout(liveTimer);
    if (page !== "devices" || !S || document.hidden) return;
    if (!alive()) return;
    liveTimer = setTimeout(async () => { await loadDevices(); keepDevicesFresh(); }, 20000);
  }

  document.getElementById("logout").addEventListener("click", async () => { await api("/api/logout", {}); location.href = "/"; });
  window.addEventListener("hashchange", () => { const p = location.hash.slice(1); if (PAGES.includes(p) && p !== page) { page = p; if (p === "devices") D = null; if (S) render(); } });
  document.addEventListener("visibilitychange", () => {
    if (page === "devices") { if (document.hidden) clearTimeout(liveTimer); else keepDevicesFresh(); }
    if (document.hidden) { clearTimeout(pollTimer); return; }
    startLive();
    // Un onglet qu'on rouvre doit retrouver sa caméra et son direct, pas un écran figé.
    if (cameraBooted) dock.ensure();
    clockTick();
  });

  // ---- Enrollment dialog -----------------------------------------------------
  const enrollDialog = (() => {
    const dialog = document.getElementById("enroll-dialog");
    const video = document.getElementById("enroll-video");
    const statusEl = document.getElementById("enroll-status");
    const consent = document.getElementById("enroll-consent");
    const capture = document.getElementById("enroll-capture");
    const countdownEl = document.getElementById("enroll-countdown");
    let memberId = null, timer = null, attempts = 0, capturing = false;
    const clearTimer = () => { if (timer) clearTimeout(timer); timer = null; countdownEl.hidden = true; };
    const close = () => { clearTimer(); stopCamera(video); if (dialog.open) dialog.close(); };

    async function open(id, name) {
      memberId = id; attempts = 0;
      document.getElementById("enroll-name").textContent = name;
      consent.checked = false;
      setStatus(statusEl, "");
      if (!dialog.open) dialog.showModal();
      const stream = await startCamera(video, statusEl);
      if (!stream) { speak("camera_denied"); return; }
      speak("camera_on");
      try {
        await FaceEngine.load((msg) => setStatus(statusEl, msg));
        setStatus(statusEl, "Caméra active. Cochez l'accord : la capture démarre automatiquement.");
        consent.focus();
      } catch (err) { setStatus(statusEl, "Moteur facial indisponible : " + err.message, "error"); }
    }

    async function doCapture() {
      if (capturing) return;
      if (!consent.checked) { setStatus(statusEl, "Cochez la case d'accord avant d'enregistrer.", "error"); return; }
      if (!video.srcObject) { setStatus(statusEl, "Caméra inactive.", "error"); return; }
      capturing = true; capture.disabled = true;
      setStatus(statusEl, "Analyse du visage…");
      let result;
      try {
        const face = await FaceEngine.describe(video, { single: true });
        if (face.status !== "ok") result = { ok: false, status: face.status, reason: face.reason, message: hintMessage(face) };
        else result = await api("/api/members/" + memberId + "/enroll", { descriptor: face.descriptor, consent: true });
      } catch (err) { result = { ok: false, status: "error", message: "Analyse impossible : " + err.message }; }
      capturing = false; capture.disabled = false;
      setStatus(statusEl, result.message, result.ok ? "ok" : "error");
      if (result.ok) {
        speak("enrolled");
        dock.refreshFeed();
        dock.reloadKnown();
        setTimeout(async () => { close(); await refresh(); }, 1800);
        return;
      }
      speakResult(result);
      attempts += 1;
      if (consent.checked && ["no_face", "multi_face"].includes(result.status) && attempts < 8) timer = setTimeout(doCapture, 2000);
    }
    function countdown(n) {
      clearTimer();
      if (n === 0) { countdownEl.hidden = true; doCapture(); return; }
      countdownEl.hidden = false; countdownEl.textContent = n;
      timer = setTimeout(() => countdown(n - 1), 800);
    }
    consent.addEventListener("change", () => { if (consent.checked && video.srcObject) { attempts = 0; countdown(3); } else clearTimer(); });
    capture.addEventListener("click", () => { clearTimer(); attempts = 0; doCapture(); });
    document.getElementById("enroll-cancel").addEventListener("click", close);
    dialog.addEventListener("cancel", () => { clearTimer(); stopCamera(video); });
    return { open, close };
  })();

  // ---- Le poste live : la caméra de ce poste, tout le temps ------------------
  // Un seul flux, un seul moteur, une seule boucle. Le panneau est créé une fois pour
  // toutes puis *déplacé* d'écran en écran : changer d'onglet ne coupe ni la caméra ni
  // le compteur. Personne n'appuie sur « Activer la caméra » : elle s'active, se
  // réessaie toute seule si la permission tarde ou si le poste se met en veille.
  const dock = (() => {
    const AUTO_KEY = "faceid.auto";
    const PAUSE_MS = 60000;      // une pause demandée à la main se lève toute seule au bout d'une minute
    const TITLES = () => ({
      granted: ({ office: "POINTAGE ENREGISTRÉ", canteen: "BON APPÉTIT" })[sector] || "ACCÈS AUTORISÉ",
      already: "DÉJÀ ENREGISTRÉ AUJOURD'HUI",
      expired: ({ office: "CONTRAT EXPIRÉ", canteen: "INSCRIPTION EXPIRÉE", coworking: "ACCÈS EXPIRÉ" })[sector] || "ABONNEMENT EXPIRÉ",
      unknown: "VISAGE INCONNU", no_face: "En attente d'un visage…", multi_face: "Une personne à la fois",
      error: "Analyse impossible", idle: "Caméra en pause", scanning: "Analyse en cours…", loading: "Chargement du moteur…",
    });
    // Le mode automatique est LA façon dont ce produit doit tourner : activé d'office,
    // et le refus explicite de l'utilisateur est la seule chose qui le coupe (pour une heure max).
    const wantsAuto = () => { try { return localStorage.getItem(AUTO_KEY) !== "off"; } catch (_) { return true; } };

    let host = null, holder = null, e = {};
    let stream = null, known = [], knownAt = 0, busy = false, lastResult = null, lastToast = null;
    let chain = null, watchdog = null, attempts = 0, pausedUntil = 0, started = false, wakeLock = null;
    const recentlySent = new Map();

    function build() {
      if (host) return;
      host = document.createElement("section");
      host.className = "live-dock";
      host.innerHTML = `
        <div class="dock-shell">
          <div class="dock-cam">
            <div class="video-wrap">
              <video id="rec-video" autoplay playsinline muted></video>
              <div id="rec-banner" class="banner banner-idle" role="status" aria-live="assertive">
                <strong id="rec-banner-title">Caméra du poste</strong>
                <span id="rec-banner-text">Activation…</span>
              </div>
            </div>
            <div class="kiosk-controls">
              <button class="btn btn-ghost btn-sm" type="button" id="rec-start">Mettre en pause</button>
              <button class="btn btn-primary btn-sm" type="button" id="rec-check" disabled>Vérifier maintenant</button>
              <label class="switch"><input type="checkbox" id="rec-auto"> Mode automatique</label>
              <button class="btn btn-link btn-sm js-voice-toggle" type="button" aria-pressed="true" title="Annonces vocales">🔊 Voix</button>
            </div>
            <p id="rec-status" class="status" aria-live="polite"></p>
          </div>
          <div class="dock-side">
            <p class="dock-title"><span class="dot-live" id="dock-dot"></span> Passages vus par ce poste <span class="badge" id="dock-count">0</span></p>
            <ul id="rec-live" class="live-list" aria-label="Derniers résultats"></ul>
            <small class="muted js-voice-info"></small>
          </div>
        </div>`;
      holder = document.createElement("div");
      holder.className = "dock-holder";
      holder.hidden = true;
      document.body.appendChild(holder);
      holder.appendChild(host);
      e = {
        video: host.querySelector("#rec-video"), status: host.querySelector("#rec-status"),
        start: host.querySelector("#rec-start"), check: host.querySelector("#rec-check"),
        auto: host.querySelector("#rec-auto"), banner: host.querySelector("#rec-banner"),
        title: host.querySelector("#rec-banner-title"), text: host.querySelector("#rec-banner-text"),
        live: host.querySelector("#rec-live"), dot: host.querySelector("#dock-dot"), count: host.querySelector("#dock-count"),
      };
      e.auto.checked = wantsAuto();
      e.start.addEventListener("click", () => (stream ? pause("manuelle") : resume(true)));
      e.check.addEventListener("click", () => { showBanner("scanning", ""); check(); });
      e.auto.addEventListener("change", () => {
        try { localStorage.setItem(AUTO_KEY, e.auto.checked ? "on" : "off"); } catch (_) { /* navigation privée */ }
        if (e.auto.checked) { say("Mode automatique : les visages sont analysés en continu dans ce navigateur."); speak("auto_on"); lastSpoken.clear(); loop(); }
        else { stopChain(); say("Mode automatique arrêté. Il reprendra tout seul à la prochaine reprise de la caméra."); speak("auto_off"); }
      });
      // Un écran qui revient du fond de la scène doit retrouver sa caméra, pas un poste à réveiller à la main.
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) { stopChain(); return; }
        keepAwake();
        if (!pausedUntil) { acquire().then((ok) => { if (ok && wantsAuto()) loop(); }); }
      });
      window.addEventListener("pagehide", hardStop);
    }

    function place(slot, wide) {
      build();
      if (!slot) { holder.appendChild(host); host.hidden = true; return; }
      slot.appendChild(host);
      host.hidden = false;
      host.classList.toggle("is-wide", Boolean(wide));
      host.classList.toggle("is-compact", !wide);
    }

    function showBanner(status, text) {
      e.banner.className = "banner banner-" + status;
      e.title.textContent = TITLES()[status] || status;
      e.text.textContent = text || "";
    }
    function say(text, kind) { e.status.textContent = text || ""; e.status.className = "status" + (kind ? " " + kind : ""); }
    function online(on) { e.dot.classList.toggle("on", Boolean(on)); syncBar(on); }
    function stopChain() { if (chain) clearTimeout(chain); chain = null; }
    function hardStop() { stopChain(); if (watchdog) clearInterval(watchdog); watchdog = null; stopCamera(e.video); stream = null; }
    function schedule(ms, what) { stopChain(); if (!alive()) return; chain = setTimeout(() => { if (alive()) what(); }, ms); }

    async function keepAwake() {
      if (!navigator.wakeLock || wakeLock) return;
      try {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener?.("release", () => { wakeLock = null; });
      } catch (_) { wakeLock = null; /* veille refusée : rien de grave, la caméra tourne quand même */ }
    }

    // --- la caméra, coûte que coûte -----------------------------------------
    async function acquire() {
      if (stream) return true;
      if (pausedUntil) return false;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showBanner("error", "Ce navigateur ne donne pas accès à une caméra.");
        say("Ce navigateur ne peut pas ouvrir de caméra : utilisez Chrome, Edge ou Safari sur le poste de l'entrée.", "error");
        return false;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
        e.video.srcObject = stream;
        await e.video.play().catch(() => {});
        // une track qui meurt (câble débranché, mise en veille, autre app) se reprend seule
        for (const track of stream.getTracks()) track.onended = () => { stream = null; online(false); schedule(1500, () => acquire().then((ok) => { if (ok) boot(); })); };
        attempts = 0;
        online(true);
        return true;
      } catch (err) {
        stream = null;
        e.video.srcObject = null;
        online(false);
        retry(err);
        return false;
      }
    }
    function retry(err) {
      attempts += 1;
      const wait = Math.min(20000, 1200 * 2 ** Math.min(attempts, 4));
      const why = !window.isSecureContext ? "La caméra exige du HTTPS (ou http://localhost)."
        : err && err.name === "NotAllowedError" ? "Autorisez la caméra dans la barre d'adresse : le poste réessaie tout seul."
        : err && err.name === "NotReadableError" ? "Une autre application tient la caméra : on réessaie."
        : err && (err.name === "NotFoundError" || err.name === "OverconstrainedError") ? "Aucune caméra détectée sur ce poste."
        : "Caméra indisponible pour l'instant.";
      showBanner("error", attempts > 1 ? `Nouvel essai dans ${Math.round(wait / 1000)} s (essai ${attempts}).` : why);
      say(why + " Le kiosque ne s'arrête pas d'essayer.", "error");
      if (attempts === 1) {
        Toast.system({
          ok: false, kind: "camera", title: "La caméra de ce poste n'est pas encore ouverte", body: why + " Rien à reprogrammer : ce poste réessaie seul, toutes les quelques secondes.",
          duration: 12000, action: { label: "Réessayer tout de suite", onClick: () => { attempts = 0; acquire().then((ok) => ok && boot()); } },
        });
      }
      schedule(wait, () => acquire().then((ok) => { if (ok) boot(); }));
    }

    // --- moteur + visages connus + boucle ------------------------------------
    async function boot() {
      try {
        await FaceEngine.load((msg) => showBanner("loading", msg));
        await reloadKnown();
        e.check.disabled = false;
        e.auto.disabled = false;
        showBanner("no_face", known.length ? known.length + " visage(s) chargé(s) sur ce poste. Placez-vous devant la caméra." : "Aucun visage enregistré : capturez vos " + sec().people + " d'abord.");
        say("Moteur " + FaceEngine.backend() + " · " + known.length + " visage(s) connus · " + (S ? S.devices.online + " kiosque(s) en ligne" : "") + ".");
        if (attempts === 0 && started !== true) Toast.system({ ok: true, title: "Caméra de ce poste active", body: "Le mode automatique tourne : chaque visage est analysé ici, aucune image ne sort de ce poste.", duration: 3600, sound: false });
        started = true;
        if (wantsAuto()) { e.auto.checked = true; loop(); }
        if (!watchdog) watchdog = setTimeout(beat, 12000);
      } catch (err) {
        showBanner("error", "Moteur facial indisponible.");
        say(String(err && err.message ? err.message : err), "error");
        schedule(8000, boot);
      }
    }
    // Une chaîne de minuteurs, jamais setInterval : une page fermée doit pouvoir mourir
    // (les tests jsdom, comme un onglet qu'on laisse dans le vide de la mémoire).
    function beat() {
      watchdog = null;
      if (!alive()) return;
      sweep();
      if (alive() && !pausedUntil) watchdog = setTimeout(beat, 12000);
    }
    // Le veilleur : un poste d'entrée doit se remettre en marche tout seul, sans personne.
    function sweep() {
      if (!alive() || document.hidden || pausedUntil) return;
      const stalled = !stream || e.video.paused || e.video.readyState === 0;
      if (stalled) { acquire().then((ok) => { if (ok && wantsAuto() && !chain) loop(); }); return; }
      if (wantsAuto() && !chain) loop();
      keepAwake();
    }
    async function reloadKnown() {
      const feed = await api("/api/descriptors");
      if (feed && feed.ok) { known = feed.data.members || []; knownAt = Date.now(); e.count.textContent = String(known.length); }
      return feed ? feed.ok : false;
    }
    function pushLive(result) {
      if (!["granted", "already", "expired", "unknown"].includes(result.status)) return;
      const li = document.createElement("li");
      li.className = "live-" + result.status;
      li.textContent = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " — " + (result.name || "Inconnu") + " — " + (TITLES()[result.status] || result.status);
      e.live.prepend(li);
      while (e.live.children.length > 6) e.live.removeChild(e.live.lastChild);
    }

    async function check() {
      if (busy || !stream) return null;
      busy = true; e.check.disabled = true;
      let result = null;
      try {
        if (Date.now() - knownAt > 60000) await reloadKnown();
        const face = await FaceEngine.describe(e.video, { single: false });
        if (face.status !== "ok") {
          result = { ok: false, code: 422, status: face.status, reason: face.reason, message: hintMessage(face) };
        } else {
          const match = FaceEngine.match(face.descriptor, known);
          if (!match) result = { ok: false, code: 404, status: "unknown", message: known.length ? "Visage non reconnu : personne non enregistrée dans votre espace." : "Aucun visage enregistré : capturez d'abord vos " + sec().people + "." };
          // La même personne revu(e) dans la demi-minute ne refait pas un passage, ni une fiche.
          else if (Date.now() - (recentlySent.get(match.member.id) || 0) < 20000) result = null;
          else {
            recentlySent.set(match.member.id, Date.now());
            result = await api("/api/recognized", { member_id: match.member.id, distance: Math.round(match.distance * 1000) / 1000 });
          }
        }
      } catch (err) {
        result = { ok: false, code: 0, status: "error", message: "Analyse impossible : " + (err && err.message ? err.message : err) };
      }
      busy = false;
      e.check.disabled = !stream;
      if (!result) { if (lastResult) showBanner(lastResult.status, lastResult.message); return { status: "skip" }; }
      lastResult = result;
      showBanner(result.status, result.message);
      say(result.status === "no_face" ? "" : result.message, result.ok ? "ok" : result.status === "no_face" ? "" : "error");
      pushLive(result);
      speakResult(result);
      // Un visage qui traîne devant le capteur ne doit pas remplir le bord d'écran de fiches
      // identiques : même verdict, même personne, moins de quinze secondes => on se tait.
      const same = lastToast && lastToast.status === result.status && (result.member_id || 0) === (lastToast.member_id || 0) && Date.now() - lastToast.at < 15000;
      if (!same && ["granted", "already", "expired", "unknown"].includes(result.status)) {
        lastToast = { status: result.status, member_id: result.member_id || 0, at: Date.now() };
        Toast.passage({ status: result.status, name: result.name, message: result.message, time: result.local_time, confidence: result.confidence, member_id: result.member_id, device: "ce poste", person: sec().person, sound: false });
      }
      if (result.ok || ["expired", "already"].includes(result.status)) refresh();
      return result;
    }
    async function loop() {
      chain = null;
      if (!alive() || document.hidden || !e.auto.checked || !stream) return;
      let delay = 700;
      const t0 = performance.now();
      const result = await check();
      const spent = performance.now() - t0;
      if (result && ["granted", "already", "expired", "unknown"].includes(result.status)) delay = 3000;
      else if (result && result.status === "error") delay = 5000;
      else delay = Math.max(500, Math.min(2500, spent * 0.5));
      if (alive() && !document.hidden && e.auto.checked && stream) chain = setTimeout(loop, delay);
    }

    // --- pause / reprise ------------------------------------------------------
    function pause(why) {
      pausedUntil = Date.now() + PAUSE_MS;
      stopChain();
      stopCamera(e.video);
      stream = null;
      online(false);
      e.start.textContent = "Reprendre maintenant";
      e.check.disabled = true;
      showBanner("idle", why === "manuelle" ? "Pause d'une minute : ce poste reprendra tout seul." : "En attente du matériel.");
      say("Caméra en pause. Reprise automatique dans une minute — ou tout de suite avec « Reprendre maintenant ».");
      schedule(PAUSE_MS, () => resume(false));
    }
    async function resume(now) {
      pausedUntil = 0;
      clearTimeout(chain); chain = null;
      e.start.textContent = "Mettre en pause";
      showBanner("loading", "Réveil de la caméra…");
      if (!(await acquire())) return;
      await boot();
      if (!now && wantsAuto()) speak("auto_on");
    }

    async function ensure(force) {
      build();
      keepAwake();
      Toast.unlock();
      if (force) { pausedUntil = 0; attempts = 0; e.start.textContent = "Mettre en pause"; }
      if (!(await acquire())) return;
      await boot();
    }
    return {
      ensure, place, pause, resume,
      reloadKnown: () => reloadKnown(),
      refreshFeed: () => { knownAt = 0; },
      running: () => Boolean(stream),
      // Un visage vient d'être capturé ou effacé : le poste doit le savoir tout de suite.
      forget: (id) => { known = known.filter((m) => m.id !== id); e.count.textContent = String(known.length); },
    };
  })();

  refresh();
})();
