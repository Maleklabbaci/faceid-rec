// Kiosk page: what a linked device does. Pair with the code the company space mints, then
// recognise faces in this browser and log the passage. Nothing else: no lists, no settings.
// The markup contract lives in kiosk.html + assets/app.css (shared .stat/.banner/.status rules).
(function () {
  "use strict";

  const VOICE_BASE = document.body.dataset.voiceBase || "/voice/";
  const KEY = "faceid.device";
  const store = {
    get token() { try { return localStorage.getItem(KEY) || ""; } catch (_) { return ""; } },
    set token(v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch (_) { /* private mode */ } },
    get auto() { try { return localStorage.getItem(KEY + ".auto") === "1"; } catch (_) { return false; } },
    set auto(v) { try { localStorage.setItem(KEY + ".auto", v ? "1" : "0"); } catch (_) { /* ignore */ } },
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    viewPair: $("view-pair"), viewRun: $("view-run"), pairForm: $("pair-form"), code: $("k-code"),
    pairError: $("k-pair-error"), pairHint: $("k-pair-hint"), pairGo: $("k-pair-go"),
    device: $("k-device"), org: $("k-org"), unpair: $("k-unpair"), pulse: $("k-pulse"), note: $("k-foot-note"), date: $("k-date"),
    video: $("rec-video"), status: $("rec-status"), start: $("rec-start"), check: $("rec-check"), auto: $("rec-auto"),
    banner: $("rec-banner"), bannerTitle: $("rec-banner-title"), bannerText: $("rec-banner-text"), live: $("rec-live"),
    countLabel: $("k-count-label"), granted: $("k-granted"), people: $("k-people"), refused: $("k-refused"),
  };

  let S = null;         // /api/device/state
  let known = [];       // descriptors of this company's consenting faces
  let knownAt = 0;
  let stream = null;
  let loop = null;
  let busy = false;
  let lastResult = null;
  const recentlySent = new Map();

  // ---- API ------------------------------------------------------------------
  // Both credentials work: the `did` cookie (a browser kiosk) and, when present, the bearer
  // token saved at pairing time (a browser that refuses cookies, or the same box as a relay).
  async function api(path, body) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (store.token) headers.Authorization = "Bearer " + store.token;
    let res;
    try {
      res = await fetch(path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
    } catch (_) {
      return { ok: false, code: 0, status: "error", data: {}, message: "Serveur injoignable. Vérifiez la connexion réseau de cet appareil." };
    }
    let data = {};
    try { data = await res.json(); } catch (_) { /* no body */ }
    return { ok: res.ok, code: res.status, status: data.status || (res.ok ? "ok" : "error"), data, message: data.message || (res.ok ? "OK" : "Erreur " + res.status) };
  }

  // ---- Voice ----------------------------------------------------------------
  const GRANTED = {
    fitness: (n) => (n ? "Bienvenue " + n + ". Accès autorisé." : "Accès autorisé. Bienvenue !"),
    coworking: (n) => (n ? "Bienvenue " + n + ". Accès autorisé." : "Accès autorisé. Bienvenue !"),
    office: (n) => (n ? "Bonjour " + n + ". Pointage enregistré." : "Pointage enregistré. Bonne journée."),
    canteen: (n) => (n ? "Bon appétit " + n + " !" : "Repas enregistré. Bon appétit !"),
  };
  const EXPIRED_WORD = { fitness: "abonnement", coworking: "accès payé", office: "contrat", canteen: "inscription" };
  const PHRASES = {
    granted: (n) => (GRANTED[sector()] || GRANTED.fitness)(n),
    already: (n) => (n ? n + ", déjà enregistré aujourd'hui. Merci." : "Déjà enregistré aujourd'hui. Merci."),
    expired: (n) => "Accès refusé. " + (n ? n + ", votre " : "Votre ") + (EXPIRED_WORD[sector()] || "abonnement") + " est expiré. Merci de passer à l'accueil.",
    unknown: () => "Accès refusé. Visage non reconnu.",
    far: () => "Approchez-vous de la caméra, s'il vous plaît.",
    none: () => "Placez-vous face à la caméra.",
    multi: () => "Une seule personne à la fois, s'il vous plaît.",
    camera_on: () => "Caméra activée. Permission accordée.",
    camera_denied: () => "Permission caméra refusée. Vérifiez les autorisations du navigateur.",
    camera_off: () => "Caméra désactivée.",
    auto_on: () => "Mode automatique activé. Présentez-vous devant la caméra.",
    auto_off: () => "Mode automatique désactivé.",
    paired: () => "Appareil relié. Le kiosque est prêt.",
  };
  const CLIPS = ["granted", "already", "expired", "unknown", "far", "none", "multi", "camera_on", "camera_denied", "auto_on", "pointage", "meal"];
  const CLIP_FOR = { granted: { office: "pointage", canteen: "meal" } };
  const HINTS = ["far", "none", "multi"];
  const FEMALE_VOICES = ["google français", "denise", "hortense", "julie", "audrey", "amélie", "amelie", "vivienne", "eloise", "éloise", "aurélie", "aurelie", "charlotte", "marie", "pauline", "sylvie", "céline", "celine", "chantal", "virginie", "léa", "coralie", "jacqueline", "female", "femme"];
  const sector = () => (S && S.org && S.org.sector) || "fitness";
  const clip = new Audio();
  const lastSpoken = new Map();
  let voiceOn = true;
  try { voiceOn = localStorage.getItem("faceid.voice") !== "off"; } catch (_) { /* default on */ }
  let ttsBusyUntil = 0;
  const busySpeaking = () => Date.now() < ttsBusyUntil || (!clip.paused && !clip.ended);
  const hasTts = typeof window.speechSynthesis !== "undefined";
  function pickVoice() {
    if (!hasTts) return null;
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
    document.querySelectorAll(".js-voice-info").forEach((x) => { x.textContent = voiceLabel(); });
    document.querySelectorAll(".js-voice-toggle").forEach((b) => { b.textContent = voiceOn ? "🔊 Voix" : "🔇 Voix coupée"; b.setAttribute("aria-pressed", String(voiceOn)); });
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
      const which = (CLIP_FOR[key] && CLIP_FOR[key][sector()]) || key;
      clip.pause(); clip.src = VOICE_BASE + which + ".mp3"; clip.currentTime = 0;
      clip.play().catch(() => {});
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
    try { localStorage.setItem("faceid.voice", voiceOn ? "on" : "off"); } catch (_) { /* ignore */ }
    if (!voiceOn && hasTts) speechSynthesis.cancel();
    if (!voiceOn) clip.pause();
    refreshVoiceInfo();
  }
  if (hasTts) speechSynthesis.addEventListener("voiceschanged", refreshVoiceInfo);

  // ---- Screen helpers -------------------------------------------------------
  function setStatus(text, kind) { el.status.textContent = text || ""; el.status.className = "status" + (kind ? " " + kind : ""); }
  function showBanner(status, text) {
    el.banner.className = "banner banner-" + status;
    el.bannerTitle.textContent = TITLES[status] || status;
    el.bannerText.textContent = text || "";
  }
  const TITLES = {
    granted: "ACCÈS AUTORISÉ", already: "DÉJÀ ENREGISTRÉ AUJOURD'HUI", expired: "ACCÈS REFUSÉ",
    unknown: "VISAGE INCONNU", no_face: "En attente d'un visage…", multi_face: "Une personne à la fois",
    error: "Erreur", idle: "Caméra inactive", scanning: "Analyse en cours…", loading: "Chargement du moteur…",
  };
  function applyTitles() {
    if (!S) return;
    const rule = S.sector.rule;
    TITLES.granted = rule === "attendance" ? "POINTAGE ENREGISTRÉ" : rule === "one_per_day" ? "BON APPÉTIT" : "ACCÈS AUTORISÉ";
    TITLES.expired = rule === "attendance" ? "CONTRAT EXPIRÉ" : rule === "one_per_day" ? "INSCRIPTION EXPIRÉE" : "ABONNEMENT EXPIRÉ";
    el.countLabel.textContent = (rule === "attendance" ? "Pointages" : rule === "one_per_day" ? "Repas" : S.sector.entries) + " du jour";
  }
  function cameraHelp(err) {
    let text;
    if (!window.isSecureContext) text = "La caméra exige du HTTPS (ou http://localhost). Ouvrez le lien en HTTPS.";
    else if (err && (err.name === "NotFoundError" || err.name === "OverconstrainedError")) text = "Aucune caméra sur cet appareil : reliez une webcam, ou utilisez un poste d'accueil.";
    else if (err && err.name === "NotReadableError") text = "Caméra déjà utilisée par une autre application.";
    else text = "Autorisez la caméra dans la barre d'adresse, puis réessayez.";
    setStatus(text, "error");
    showBanner("error", "Caméra indisponible.");
  }
  async function startCamera() {
    if (stream) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { cameraHelp(null); return false; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      el.video.srcObject = stream;
      await el.video.play().catch(() => {});
      return true;
    } catch (err) { cameraHelp(err); speak("camera_denied"); return false; }
  }
  function stopCamera() {
    if (loop) { clearTimeout(loop); loop = null; }
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    el.video.srcObject = null;
  }

  // ---- Pairing --------------------------------------------------------------
  // A shared link carries the code; a typed one carries just the code. Both arrive here.
  function extractCode(text) {
    const fromLink = /pair=([A-Za-z0-9]{6,10})/.exec(String(text || ""));
    if (fromLink) return fromLink[1].toUpperCase();
    return String(text || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  }
  function view(which) {
    el.viewPair.hidden = which !== "pair";
    el.viewRun.hidden = which !== "run";
    el.unpair.hidden = which !== "run";
  }
  async function pairWith(code) {
    el.pairError.textContent = "";
    if (code.length !== 6) { el.pairError.textContent = "Un code d'appairage compte 6 caractères."; return false; }
    el.pairGo.disabled = true;
    el.pairGo.textContent = "Vérification…";
    const r = await api("/api/pair", { code });
    el.pairGo.disabled = false;
    el.pairGo.textContent = "Relier cet appareil";
    if (!r.ok) { el.pairError.textContent = r.message; return false; }
    store.token = r.data.token;
    el.code.value = "";
    speak("paired");
    await boot(true);
    return true;
  }
  async function unpair() {
    if (window.confirm && !window.confirm("Quitter ce kiosque ? Cet appareil devra saisir un nouveau code pour repartir.")) return;
    await api("/api/device/unpair", {});
    store.token = "";
    stopCamera();
    S = null;
    view("pair");
    el.device.textContent = "non relié";
    el.device.className = "badge";
    el.org.textContent = "";
    el.note.textContent = "Kiosque en attente d'appairage.";
    el.pulse.classList.add("idle");
  }

  // ---- Running state --------------------------------------------------------
  function paintState() {
    document.body.className = "kiosk-page sector-" + S.org.sector;
    document.title = S.device.name + " — Kiosque FaceID";
    el.device.textContent = S.device.name + " · " + S.device.kind_label;
    el.device.className = "badge badge-live";
    el.org.textContent = S.org.name;
    el.date.textContent = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    el.granted.textContent = S.granted;
    el.people.textContent = S.people;
    el.refused.textContent = S.refused;
    applyTitles();
    if (!el.live.children.length) (S.logs || []).slice(0, 6).forEach(push);
  }
  function push(entry) {
    const li = document.createElement("li");
    li.className = "live-" + (entry.status || "unknown");
    const name = document.createElement("b");
    name.textContent = entry.name || "Inconnu";
    const text = document.createElement("span");
    text.textContent = entry.message || TITLES[entry.status] || "";
    const time = document.createElement("time");
    time.textContent = entry.local_time || new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    li.append(name, text, time);
    el.live.prepend(li);
    while (el.live.children.length > 7) el.live.removeChild(el.live.lastChild);
  }
  async function reloadKnown() {
    const r = await api("/api/device/descriptors");
    if (!r.ok) return false;
    known = r.data.members || [];
    knownAt = Date.now();
    return true;
  }

  // ---- The check ------------------------------------------------------------
  async function check() {
    if (busy || !stream) return null;
    busy = true;
    el.check.disabled = true;
    let result = null;
    try {
      if (Date.now() - knownAt > 60000) await reloadKnown();
      if (!known.length) {
        result = { ok: false, status: "unknown", message: "Aucun visage enregistré dans cet espace : demandez à l'administrateur de capturer les " + S.sector.people + "." };
      } else {
        const face = await window.FaceEngine.describe(el.video, { single: false });
        if (face.status !== "ok") {
          result = { ok: false, status: face.status, reason: face.reason, message: face.reason === "far" ? "Approchez-vous de la caméra." : "Placez le visage au centre de l'image." };
        } else {
          const match = window.FaceEngine.match(face.descriptor, known);
          if (!match) result = { ok: false, status: "unknown", message: "Visage non reconnu." };
          else if (Date.now() - (recentlySent.get(match.member.id) || 0) < 4000) result = null;
          else {
            recentlySent.set(match.member.id, Date.now());
            result = await api("/api/device/recognized", { member_id: match.member.id, distance: Math.round(match.distance * 1000) / 1000 });
          }
        }
      }
    } catch (err) {
      result = { ok: false, status: "error", message: "Analyse impossible : " + (err && err.message ? err.message : err) };
    }
    busy = false;
    el.check.disabled = false;
    if (!result) { if (lastResult) showBanner(lastResult.status, lastResult.message); return null; }
    lastResult = result;
    showBanner(result.status, result.message);
    setStatus(result.status === "no_face" ? "" : result.message, result.ok ? "ok" : result.status === "no_face" ? "" : "error");
    if (["granted", "already", "expired", "unknown"].includes(result.status)) {
      push({ status: result.status, name: result.name, message: result.message, local_time: result.local_time });
      speakResult(result);
      const fresh = await api("/api/device/state");
      if (fresh.ok) { const logs = S.logs; S = fresh.data; S.logs = logs; paintState(); }
    }
    return result;
  }
  function tick() {
    loop = null;
    if (!el.auto.checked || !stream) return;
    let delay = 700;
    if (!document.hidden) {
      const started = Date.now();
      check().then((result) => {
        if (result && ["granted", "already", "expired", "unknown"].includes(result.status)) delay = 3000;
        else if (result && result.status === "error") delay = 5000;
        else delay = Math.max(500, Math.min(2500, Date.now() - started));
        if (el.auto.checked && stream) loop = setTimeout(tick, delay);
      });
      return;
    }
    loop = setTimeout(tick, 2000);
  }
  // ---- Power: camera + engine, from the button or from a remembered setting ----
  async function powerOn(silent) {
    if (!S) return false;
    showBanner("loading", silent ? "Réveil du kiosque…" : "Autorisation de la caméra…");
    if (!(await startCamera())) return false;
    if (!silent) speak("camera_on");
    el.start.textContent = "Couper la caméra";
    try {
      await window.FaceEngine.load((msg) => setStatus(msg));
      await reloadKnown();
      el.check.disabled = false;
      el.auto.disabled = false;
      showBanner("no_face", known.length + " visage(s) chargés sur cet appareil. Placez-vous face à la caméra.");
      setStatus("Moteur " + window.FaceEngine.backend() + " · " + known.length + " visage(s) connus. " + (S.sector.rule === "one_per_day" ? "Un seul repas par personne et par jour." : "Chaque visage est analysé ici, aucune image n'est envoyée."));
      el.note.textContent = "Kiosque actif — " + S.device.name;
      el.pulse.classList.remove("idle");
      if (store.auto) { el.auto.checked = true; if (!silent) speak("auto_on"); tick(); }
      return true;
    } catch (err) { showBanner("error", "Moteur facial indisponible."); setStatus(String(err && err.message ? err.message : err), "error"); return false; }
  }
  function powerOff() {
    stopCamera();
    el.auto.checked = false;
    el.auto.disabled = true;
    el.start.textContent = "Activer la caméra";
    el.check.disabled = true;
    showBanner("idle", "Cliquez sur « Activer la caméra » pour reprendre.");
    setStatus("");
    el.note.textContent = "Caméra en veille.";
    el.pulse.classList.add("idle");
    speak("camera_off");
  }
  function toggleCamera() { if (stream) { store.auto = false; powerOff(); } else powerOn(false); }

  // ---- Boot -----------------------------------------------------------------
  async function boot(justPaired) {
    const r = await api("/api/device/state");
    if (r.code === 401) {
      store.token = "";
      S = null;
      view("pair");
      el.device.textContent = "non relié";
      el.note.textContent = justPaired ? "Kiosque en attente." : "Cet appareil n'est plus relié : saisissez un nouveau code.";
      el.pulse.classList.add("idle");
      return;
    }
    if (!r.ok) { setStatus(r.message, "error"); showBanner("error", r.message); view("run"); return; }
    S = r.data;
    view("run");
    paintState();
    if (justPaired) { store.auto = true; if (!(await powerOn(true))) { showBanner("idle", "Kiosque relié. Activez la caméra pour commencer."); el.note.textContent = "Kiosque prêt — " + S.device.name; } }
    else if (store.auto) await powerOn(true);
  }

  // ---- Wiring ---------------------------------------------------------------
  el.pairForm.addEventListener("submit", (event) => {
    event.preventDefault();
    pairWith(extractCode(el.code.value));
  });
  el.start.addEventListener("click", toggleCamera);
  el.check.addEventListener("click", () => { showBanner("scanning", ""); check(); });
  el.auto.addEventListener("change", () => {
    store.auto = el.auto.checked;
    if (el.auto.checked) { setStatus("Mode automatique : les visages sont analysés en continu dans ce navigateur."); speak("auto_on"); if (stream) tick(); }
    else { if (loop) { clearTimeout(loop); loop = null; } setStatus("Mode automatique arrêté."); speak("auto_off"); }
  });
  el.unpair.addEventListener("click", unpair);
  document.querySelectorAll(".js-voice-toggle").forEach((b) => b.addEventListener("click", toggleVoice));
  window.addEventListener("pagehide", () => { stopCamera(); if (hasTts) speechSynthesis.cancel(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && S && el.auto.checked && stream && !loop) tick(); });

  (async function start() {
    refreshVoiceInfo();
    const params = new URLSearchParams(location.search);
    const fromLink = extractCode(params.get("pair") || "");
    if (params.has("pair")) {
      history.replaceState(null, "", location.pathname); // the code is single-use: keep it out of the address bar and the history
      el.pairHint.hidden = false;
      const ok = await pairWith(fromLink);
      el.pairHint.hidden = true;
      if (!ok) el.code.value = fromLink;
      return;
    }
    if (fromLink) el.code.value = fromLink;
    await boot(false);
  })();
})();
