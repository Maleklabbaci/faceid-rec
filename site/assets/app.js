(function () {
  "use strict";

  const embedded = window.self !== window.top;
  const VOICE_BASE = document.body.dataset.voiceBase || "/voice/";
  const PAGES = ["overview", "members", "access", "devices", "settings"];
  const DEVICE_KINDS = [["kiosk", "Kiosque d'entrée"], ["phone", "Téléphone"], ["tablet", "Tablette"], ["desk", "Poste d'accueil"], ["box", "Boîtier / caméra"]];
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  let S = null; // server state (/api/state)
  let D = null; // linked devices (/api/devices), loaded on demand
  let pendingPair = null; // the pairing code just minted, until it is used or expires
  let countdownTimer = null; // one 1-second chain paints every remaining-time cell of the board
  let page = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
  let sector = "fitness";
  let pendingCapture = null; // member id to enroll right after creation

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

  const flashEl = document.getElementById("flash");
  let flashTimer = null;
  function flash(message, kind) {
    flashEl.textContent = message;
    flashEl.className = "flash flash-" + (kind || "success");
    flashEl.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashEl.hidden = true; }, 6000);
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
  function journal(rows) {
    const s = sec();
    if (!rows.length) return `<p class="muted">Aucun ${esc(s.entry.toLowerCase())} enregistré pour le moment.</p>`;
    return `<table><thead><tr><th>${esc(cap(s.person))}</th><th>Méthode</th><th>Résultat</th><th>Heure</th><th>Date</th></tr></thead><tbody>` +
      rows.map((l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.method)}</td><td>${l.status === "granted" ? `<span class="badge badge-ok">${s.rule === "attendance" ? "Pointé" : "Autorisé"}</span>` : '<span class="badge badge-warn">Refusé</span>'}${l.late ? ' <span class="badge badge-late">Retard</span>' : ""}</td><td>${esc(l.local_time || "—")}</td><td class="muted">${esc(l.local_date)}</td></tr>`).join("") +
      "</tbody></table>";
  }

  function renderOverview() {
    const s = sec();
    const max = Math.max(1, ...S.chart.map((c) => c.count));
    const next = s.rule === "attendance"
      ? { href: "#access", label: "Voir les présences du jour" }
      : { href: "#members", label: "Ajouter un·e " + s.person };
    let html = `<div class="page-head"><h1>Tableau de bord</h1><span class="muted small">${esc(s.label)} · journée du ${esc(S.today)}</span><a class="btn btn-ghost btn-sm" href="${next.href}">${esc(next.label)}</a></div><div class="stats">` +
      S.kpis.map(([label, value, tone]) => `<div class="stat"><span class="stat-label">${esc(label)}</span><span class="stat-value ${tone}">${esc(value)}</span></div>`).join("") + "</div>";
    if (s.rule === "attendance") {
      html += `<section class="card"><h2>Présences du jour <span class="muted small">— début ${esc(S.org.work_start)}, tolérance ${esc(S.org.late_tolerance)} min</span></h2>`;
      html += S.attendance.length
        ? `<table><thead><tr><th>Employé</th><th>Arrivée</th><th>Statut</th></tr></thead><tbody>${S.attendance.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.arrival || "—")}</td><td>${a.arrival ? '<span class="badge badge-ok">Présent</span>' + (a.late ? ' <span class="badge badge-late">En retard</span>' : "") : '<span class="badge badge-warn">Absent</span>'}</td></tr>`).join("")}</tbody></table>`
        : '<p class="muted">Ajoutez vos employés pour suivre les présences.</p>';
      html += "</section>";
    }
    // The bar height travels as data-height: the page is served with `style-src 'self'`
    // (no 'unsafe-inline'), so a style="…" attribute written into the markup is refused by
    // the browser and every bar collapses to its min-height. Heights are applied from JS below.
    html += `<section class="card"><h2>${esc(s.entries)} sur 7 jours</h2><div class="chart">` +
      S.chart.map((c) => `<div class="bar-wrap"><div class="bar" data-height="${Math.round((c.count / max) * 100)}"><span>${c.count}</span></div><small>${esc(c.day)}</small></div>`).join("") + "</div></section>";
    html += `<section class="card"><h2>Derniers ${esc(s.entries.toLowerCase())}</h2>${journal(S.logs.slice(0, 10))}</section>`;
    return html;
  }

  function renderMembers() {
    const s = sec();
    const active = S.members.filter((m) => m.subscription_end >= S.today).length;
    let html = `<div class="page-head"><h1>${esc(cap(s.people))}</h1><span class="muted small">${S.members.length} ${esc(s.people)}, ${active} avec ${esc(s.access).toLowerCase()} actif(ve)</span></div>
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
      <section class="card"><h2>Liste (${S.members.length})</h2>`;
    if (!S.members.length) html += `<p class="muted">Aucun ${esc(s.person)}. Ajoutez le premier ci-dessus.</p>`;
    else {
      html += `<table><thead><tr><th>Nom</th><th>Email</th><th>${esc(s.access)} jusqu'au</th><th>Statut</th><th>Visage</th><th>Actions</th></tr></thead><tbody>` +
        S.members.map((m) => `<tr>
          <td>${esc(m.name)}</td><td class="muted">${esc(m.email || "—")}</td><td>${esc(m.subscription_end)}</td><td>${badge(m.subscription_end)}</td>
          <td>${m.enrolled ? `<span class="badge badge-info">Enregistré</span> <button class="btn btn-link btn-sm" type="button" data-action="revoke" data-id="${m.id}">Effacer</button>` : `<button class="btn btn-ghost btn-sm" type="button" data-action="enroll" data-id="${m.id}" data-name="${esc(m.name)}">📷 Capturer</button>`}</td>
          <td class="actions">
            <form class="inline" data-api="/api/members/${m.id}/renew"><input type="date" name="subscription_end" required value="${esc(m.subscription_end)}"><button class="btn btn-ghost btn-sm" type="submit">Renouveler</button></form>
            <button class="btn btn-danger btn-sm" type="button" data-action="delete" data-id="${m.id}" data-name="${esc(m.name)}">Supprimer</button>
          </td></tr>`).join("") + "</tbody></table>";
    }
    return html + "</section>";
  }

  function manualList() {
    const s = sec();
    if (!S.members.length) return `<p class="muted">Ajoutez d'abord des ${esc(s.people)}.</p>`;
    return `<ul class="member-list">${S.members.map((m) => `<li><span>${esc(m.name)} ${badge(m.subscription_end)}</span><button class="btn btn-ghost btn-sm" type="button" data-action="entry" data-id="${m.id}" ${m.subscription_end < S.today ? "disabled" : ""}>Valider</button></li>`).join("")}</ul>`;
  }

  function renderAccess() {
    const s = sec();
    const rule = s.rule === "attendance" ? "le pointage est horodaté et les retards calculés" : s.rule === "one_per_day" ? "un seul repas par personne et par jour" : "l'accès est contrôlé selon la date payée";
    return `<div class="page-head"><h1>${s.rule === "attendance" ? "Pointage" : "Contrôle d'accès"}</h1><span class="muted small">Ce poste-ci sert de kiosque ; un téléphone ou une caméra peuvent en faire un autre.</span><a class="btn btn-ghost btn-sm" href="#devices">Relier un appareil</a></div>
      <div class="two-cols">
        <section class="card kiosk"><h2>Reconnaissance faciale</h2>
          <p class="muted small">Activez la caméra puis le mode automatique : chaque visage est analysé dans ce navigateur (aucune image envoyée), ${rule}. Aucune porte n'est actionnée depuis le navigateur (boîtier sur site à venir).</p>
          <div class="video-wrap"><video id="rec-video" autoplay playsinline muted></video>
            <div id="rec-banner" class="banner banner-idle" aria-live="assertive"><strong id="rec-banner-title">Caméra inactive</strong><span id="rec-banner-text">Cliquez sur « Activer la caméra ».</span></div></div>
          <p id="rec-status" class="status" aria-live="polite"></p>
          <div class="kiosk-controls">
            <button class="btn btn-ghost" type="button" id="rec-start">Activer la caméra</button>
            <button class="btn btn-primary" type="button" id="rec-check" disabled>Vérifier maintenant</button>
            <label class="switch"><input type="checkbox" id="rec-auto" disabled> Mode automatique (kiosque)</label>
            <button class="btn btn-ghost btn-sm js-voice-toggle" type="button" aria-pressed="true" title="Annonces vocales">🔊 Voix</button>
          </div>
          <small class="muted js-voice-info"></small>
          <ul id="rec-live" class="live-list" aria-label="Derniers résultats"></ul>
        </section>
        <section class="card"><h2>${esc(s.manual)}</h2><p class="muted small">Sans caméra : sélectionnez la personne et validez.</p><div id="manual-list">${manualList()}</div></section>
      </div>
      <section class="card"><h2>Journal des ${esc(s.entries.toLowerCase())}</h2><div id="access-journal">${journal(S.logs)}</div></section>`;
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
    countdownTimer = setTimeout(paintCountdowns, 1000);
  }

  function renderSettings() {
    const s = sec();
    return `<div class="page-head"><h1>Paramètres de l'espace</h1><span class="muted small">${esc(s.label)}</span></div>
      <section class="card"><h2>Entreprise</h2>
        <form class="stack" data-api="/api/settings">
          <label>Nom de l'entreprise<input name="company" required maxlength="100" value="${esc(S.org.name)}"></label>
          <label>Secteur (adapte le vocabulaire, les indicateurs et les règles d'accès)
            <select name="sector">${Object.entries(S.sectors).map(([k, v]) => `<option value="${k}" ${k === S.org.sector ? "selected" : ""}>${esc(v.label)} — ${esc(v.pitch)}</option>`).join("")}</select></label>
          <label>Fuseau horaire (horodatage des ${esc(s.entries.toLowerCase())})
            <select name="timezone">${S.timezones.map((tz) => `<option value="${tz}" ${tz === S.org.timezone ? "selected" : ""}>${tz}</option>`).join("")}</select></label>
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
      <section class="card"><h2>Règles actives pour « ${esc(s.label)} »</h2>
        <ul class="checklist">
          <li>Vocabulaire : ${esc(s.people)}, ${esc(s.access.toLowerCase())}, ${esc(s.entries.toLowerCase())}.</li>
          ${s.rule === "attendance" ? "<li>Premier pointage du jour horodaté ; retard calculé selon l'heure de début et la tolérance.</li>" : ""}
          ${s.rule === "one_per_day" ? "<li>Un seul repas par personne et par jour : le deuxième passage est refusé et annoncé.</li>" : ""}
          <li>${esc(s.access)} expiré(e) = refus journalisé. Même personne reconnue deux fois en moins d'une minute = un seul enregistrement.</li>
          <li>Chaque entreprise ne voit que ses propres données ; les empreintes faciales sont calculées dans le navigateur, enregistrées avec accord et effaçables.</li>
        </ul>
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
  function render() {
    if (page !== "devices") { clearTimeout(countdownTimer); countdownTimer = null; clearTimeout(liveTimer); }
    sector = S.org.sector;
    document.body.className = "app sector-" + sector;
    document.title = S.org.name + " — FaceID Platform";
    document.getElementById("org-name").textContent = S.org.name;
    document.getElementById("org-sector").textContent = S.sector.label;
    document.getElementById("user-email").textContent = S.user.email;
    const labels = { overview: "Tableau de bord", members: cap(S.sector.people), access: S.sector.rule === "attendance" ? "Pointage" : "Contrôle d'accès", devices: "Appareils reliés", settings: "Paramètres" };
    document.querySelectorAll("#menu a").forEach((a) => { a.textContent = labels[a.dataset.page]; a.classList.toggle("active", a.dataset.page === page); });

    if (page === "devices") {
      if (!D) { loadDevices(); return; }
      pageEl.innerHTML = renderDevices();
      paintPairing();
      paintCountdowns();
      refreshVoiceInfo();
      keepDevicesFresh();
      return;
    }
    if (page === "access" && document.getElementById("rec-video")) {
      // Keep the running camera: only refresh the dynamic parts.
      document.getElementById("manual-list").innerHTML = manualList();
      document.getElementById("access-journal").innerHTML = journal(S.logs);
      return;
    }
    kiosk.unmount();
    pageEl.innerHTML = { overview: renderOverview, members: renderMembers, access: renderAccess, settings: renderSettings }[page]();
    applyBarHeights(pageEl);
    refreshVoiceInfo();
    if (page === "access") kiosk.mount();
    if (page === "members" && pendingCapture) {
      const m = S.members.find((x) => x.id === pendingCapture);
      pendingCapture = null;
      if (m) enrollDialog.open(m.id, m.name);
    }
  }

  async function refresh() {
    const r = await api("/api/state");
    if (!r.ok) { if (r.code !== 401) flash(r.message, "error"); return; }
    S = r.data;
    // The devices board shows what another screen is doing right now: never render it from a cache.
    if (page === "devices") { D = null; render(); await loadDevices(); return; }
    render();
  }

  // ---- Actions ---------------------------------------------------------------
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
    const chip = event.target.closest(".chip");
    if (chip) {
      const input = document.getElementById(chip.closest(".quick-dates").dataset.target);
      input.value = addPeriod(S.today, { days: Number(chip.dataset.days || 0), months: Number(chip.dataset.months || 0) });
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
    if (r.ok || r.status === "already") { await refresh(); if (action === "revoke") kiosk.reloadKnown(); }
  });

  // The devices page is a live board: an apparatus that just came online should show up.
  // A timeout chain, not an interval — a timer that never ends would keep the page (and the
  // test runner) alive forever; this one stops as soon as we leave the page or it is hidden.
  let liveTimer = null;
  function keepDevicesFresh() {
    clearTimeout(liveTimer);
    if (page !== "devices" || !S || document.hidden) return;
    liveTimer = setTimeout(async () => { await loadDevices(); keepDevicesFresh(); }, 20000);
  }

  document.getElementById("logout").addEventListener("click", async () => { await api("/api/logout", {}); location.href = "/"; });
  window.addEventListener("hashchange", () => { const p = location.hash.slice(1); if (PAGES.includes(p) && p !== page) { page = p; if (p === "devices") D = null; if (S) render(); } });
  document.addEventListener("visibilitychange", () => { if (page === "devices") { if (document.hidden) clearTimeout(liveTimer); else keepDevicesFresh(); } });

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
        kiosk.reloadKnown();
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

  // ---- Recognition kiosk: detection + matching in the browser ----------------
  const kiosk = (() => {
    let video, statusEl, startBtn, checkBtn, autoBox, banner, bannerTitle, bannerText, live;
    let timer = null, busy = false, known = [], knownAt = 0, mounted = false, lastResult = null;
    const recentlySent = new Map();
    const TITLES = () => ({
      granted: ({ office: "POINTAGE ENREGISTRÉ", canteen: "BON APPÉTIT" })[sector] || "ACCÈS AUTORISÉ",
      already: "DÉJÀ ENREGISTRÉ AUJOURD'HUI",
      expired: ({ office: "CONTRAT EXPIRÉ", canteen: "INSCRIPTION EXPIRÉE", coworking: "ACCÈS EXPIRÉ" })[sector] || "ABONNEMENT EXPIRÉ",
      unknown: "VISAGE INCONNU", no_face: "En attente d'un visage…", multi_face: "Une personne à la fois", error: "Erreur", idle: "Caméra inactive", scanning: "Analyse en cours…", loading: "Chargement du moteur…",
    });
    function showBanner(status, text) { if (!banner) return; banner.className = "banner banner-" + status; bannerTitle.textContent = TITLES()[status] || status; bannerText.textContent = text || ""; }
    function pushLive(result) {
      if (!["granted", "already", "expired", "unknown"].includes(result.status)) return;
      const li = document.createElement("li");
      li.className = "live-" + result.status;
      li.textContent = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " — " + (result.name || "Inconnu") + " — " + TITLES()[result.status];
      live.prepend(li);
      while (live.children.length > 6) live.removeChild(live.lastChild);
    }
    async function reloadKnown() {
      const r = await api("/api/descriptors");
      if (r.ok) { known = r.data.members; knownAt = Date.now(); }
      return r.ok;
    }
    async function check() {
      if (busy || !video || !video.srcObject) return null;
      busy = true; checkBtn.disabled = true;
      let result;
      try {
        if (Date.now() - knownAt > 60000) await reloadKnown();
        const face = await FaceEngine.describe(video, { single: false });
        if (face.status !== "ok") result = { ok: false, code: 422, status: face.status, reason: face.reason, message: hintMessage(face) };
        else {
          const match = FaceEngine.match(face.descriptor, known);
          if (!match) result = { ok: false, code: 404, status: "unknown", message: known.length ? "Visage non reconnu : personne non enregistrée dans votre espace." : "Aucun visage enregistré : capturez d'abord vos " + sec().people + "." };
          else if (Date.now() - (recentlySent.get(match.member.id) || 0) < 4000) result = null; // same person, already handled seconds ago
          else {
            recentlySent.set(match.member.id, Date.now());
            result = await api("/api/recognized", { member_id: match.member.id, distance: Math.round(match.distance * 1000) / 1000 });
            if (result.ok || ["expired", "already"].includes(result.status)) refresh();
          }
        }
      } catch (err) { result = { ok: false, code: 0, status: "error", message: "Analyse impossible : " + err.message }; }
      busy = false; checkBtn.disabled = !video.srcObject;
      if (!result) { if (lastResult) showBanner(lastResult.status, lastResult.message); return { status: "skip" }; }
      lastResult = result;
      showBanner(result.status, result.message);
      setStatus(statusEl, result.status === "no_face" ? "" : result.message, result.ok ? "ok" : result.status === "no_face" ? "" : "error");
      pushLive(result);
      speakResult(result);
      return result;
    }
    const stopAuto = () => { if (timer) clearTimeout(timer); timer = null; };
    async function loop() {
      timer = null;
      if (!mounted || !autoBox.checked || !video.srcObject) return;
      let delay = 700;
      if (!document.hidden) {
        const t0 = performance.now();
        const result = await check();
        const spent = performance.now() - t0;
        if (result && ["granted", "already", "expired", "unknown"].includes(result.status)) delay = 3000;
        else if (result && result.status === "error") delay = 5000;
        else delay = Math.max(500, Math.min(2500, spent * 0.5));
      }
      if (mounted && autoBox.checked && video.srcObject) timer = setTimeout(loop, delay);
    }
    async function toggleCamera() {
      if (video.srcObject) {
        stopAuto(); autoBox.checked = false; autoBox.disabled = true; stopCamera(video);
        startBtn.textContent = "Activer la caméra"; checkBtn.disabled = true;
        showBanner("idle", "Cliquez sur « Activer la caméra »."); setStatus(statusEl, ""); speak("camera_off");
        return;
      }
      showBanner("scanning", "Demande d'autorisation…");
      const stream = await startCamera(video, statusEl);
      if (!stream) { showBanner("error", "Caméra indisponible."); speak("camera_denied"); return; }
      speak("camera_on");
      showBanner("loading", "Première utilisation : téléchargement du moteur facial.");
      try {
        await FaceEngine.load((msg) => setStatus(statusEl, msg));
        await reloadKnown();
        startBtn.textContent = "Couper la caméra"; checkBtn.disabled = false; autoBox.disabled = false;
        showBanner("no_face", "Placez le visage au centre de l'image.");
        setStatus(statusEl, "Caméra active (moteur " + FaceEngine.backend() + ", " + known.length + " visage(s) connus). Cliquez sur « Vérifier maintenant » ou activez le mode automatique.");
      } catch (err) { showBanner("error", "Moteur facial indisponible."); setStatus(statusEl, err.message, "error"); }
    }
    function mount() {
      video = document.getElementById("rec-video"); statusEl = document.getElementById("rec-status"); startBtn = document.getElementById("rec-start");
      checkBtn = document.getElementById("rec-check"); autoBox = document.getElementById("rec-auto"); banner = document.getElementById("rec-banner");
      bannerTitle = document.getElementById("rec-banner-title"); bannerText = document.getElementById("rec-banner-text"); live = document.getElementById("rec-live");
      mounted = true;
      startBtn.addEventListener("click", toggleCamera);
      checkBtn.addEventListener("click", () => { showBanner("scanning", ""); check(); });
      autoBox.addEventListener("change", () => {
        stopAuto();
        if (autoBox.checked) { setStatus(statusEl, "Mode automatique actif : les visages sont analysés en continu dans ce navigateur."); speak("auto_on"); lastSpoken.clear(); loop(); }
        else { setStatus(statusEl, "Mode automatique arrêté."); speak("auto_off"); }
      });
    }
    function unmount() { if (!mounted) return; stopAuto(); stopCamera(video); mounted = false; video = banner = null; }
    window.addEventListener("pagehide", unmount);
    return { mount, unmount, reloadKnown };
  })();

  refresh();
})();
