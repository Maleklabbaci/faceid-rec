(function () {
  "use strict";

  const csrf = document.querySelector('input[name="csrf"]')?.value || "";
  const embedded = window.self !== window.top;

  // ---- Voice announcements ---------------------------------------------
  // Free, no API key: the browser's own French speech synthesis (same engine as
  // Google Translate in Chrome) when a *female* French voice is available, so
  // the kiosk can greet members by name. Otherwise, recorded female clips
  // served from /static/voice are used for the fixed phrases.
  const VOICE_BASE = document.body.dataset.voiceBase || "/static/voice/";
  const PHRASES = {
    granted: (n) => (n ? "Bienvenue " + n + ". Accès autorisé." : "Accès autorisé. Bienvenue !"),
    expired: (n) => "Accès refusé. " + (n ? n + ", votre" : "Votre") + " abonnement est expiré. Merci de passer à l'accueil.",
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
  const CLIPS = ["granted", "expired", "unknown", "far", "none", "multi", "camera_on", "camera_denied", "auto_on", "enrolled"];
  // Known female French voices, by preference (Chrome, Edge, Windows, macOS, iOS).
  const FEMALE_VOICES = ["google français", "denise", "hortense", "julie", "audrey", "amélie", "amelie", "vivienne", "eloise", "éloise", "aurélie", "aurelie", "charlotte", "marie", "pauline", "sylvie", "céline", "celine", "chantal", "virginie", "léa", "coralie", "jacqueline", "brigitte", "female", "femme"];
  const HINTS = ["far", "none", "multi"]; // low-priority: never interrupt a running announcement
  const clipPlayer = new Audio();
  const lastSpoken = new Map();
  let voiceOn = localStorage.getItem("faceid.voice") !== "off";
  let ttsBusyUntil = 0;

  function busySpeaking() {
    return Date.now() < ttsBusyUntil || (!clipPlayer.paused && !clipPlayer.ended);
  }

  function pickVoice() {
    if (!("speechSynthesis" in window)) return null;
    const fr = speechSynthesis.getVoices().filter((v) => /^fr/i.test(v.lang));
    for (const key of FEMALE_VOICES) {
      const match = fr.find((v) => v.name.toLowerCase().includes(key));
      if (match) return match;
    }
    return null;
  }

  function voiceLabel() {
    if (!voiceOn) return "Annonces vocales désactivées.";
    const v = pickVoice();
    return v ? "Voix : " + v.name + " (synthèse vocale gratuite du navigateur)." : "Voix : enregistrée (le navigateur n'a pas de voix féminine française).";
  }

  function refreshVoiceInfo() {
    document.querySelectorAll(".js-voice-info").forEach((el) => { el.textContent = voiceLabel(); });
    document.querySelectorAll(".js-voice-toggle").forEach((btn) => {
      btn.textContent = voiceOn ? "🔊 Voix" : "🔇 Voix coupée";
      btn.setAttribute("aria-pressed", String(voiceOn));
    });
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
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = 1;
      u.pitch = 1;
      ttsBusyUntil = now + Math.min(8000, 500 + text.length * 75); // estimate; Chrome's "speaking" flag is unreliable
      u.onend = u.onerror = () => { ttsBusyUntil = 0; };
      speechSynthesis.speak(u);
    } else if (CLIPS.includes(key)) {
      clipPlayer.pause();
      clipPlayer.src = VOICE_BASE + key + ".mp3";
      clipPlayer.currentTime = 0;
      clipPlayer.play().catch(() => { /* needs a prior click on the page */ });
    }
  }

  function speakResult(result) {
    const gap = 8000; // do not repeat the same announcement for the same person within 8 s
    if (result.status === "granted") speak("granted", result.name, gap);
    else if (result.status === "expired") speak("expired", result.name, gap);
    else if (result.status === "unknown") speak("unknown", "", gap);
    else if (result.status === "no_face") speak(result.reason === "far" ? "far" : "none", "", 12000);
    else if (result.status === "multi_face") speak("multi", "", 8000);
  }

  if ("speechSynthesis" in window) speechSynthesis.addEventListener("voiceschanged", refreshVoiceInfo);
  document.querySelectorAll(".js-voice-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      voiceOn = !voiceOn;
      localStorage.setItem("faceid.voice", voiceOn ? "on" : "off");
      if (!voiceOn) { if ("speechSynthesis" in window) speechSynthesis.cancel(); clipPlayer.pause(); }
      refreshVoiceInfo();
      if (voiceOn) speak("voice_on");
    });
  });
  refreshVoiceInfo();
  window.addEventListener("pagehide", () => { if ("speechSynthesis" in window) speechSynthesis.cancel(); });

  // Confirm destructive forms
  document.querySelectorAll("form.js-confirm").forEach((form) => {
    form.addEventListener("submit", (event) => {
      if (!window.confirm(form.dataset.confirm || "Confirmer ?")) event.preventDefault();
    });
  });

  // ---- Camera helpers --------------------------------------------------
  function setStatus(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.className = "status" + (kind ? " " + kind : "");
  }

  function cameraHelp(el, err) {
    // Explain the most frequent blockers and offer the "open in a new tab" escape hatch.
    let text;
    if (!window.isSecureContext) {
      text = "La caméra exige une connexion HTTPS (ou http://localhost).";
    } else if (err && (err.name === "NotFoundError" || err.name === "OverconstrainedError")) {
      text = "Aucune caméra détectée sur cet appareil.";
    } else if (err && err.name === "NotReadableError") {
      text = "La caméra est déjà utilisée par une autre application.";
    } else if (embedded) {
      text = "Le navigateur bloque la caméra dans cette fenêtre intégrée.";
    } else {
      text = "Accès caméra refusé : autorisez la caméra dans la barre d'adresse puis réessayez.";
    }
    setStatus(el, text + " ", "error");
    if (embedded) {
      const link = document.createElement("a");
      link.href = window.location.href;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Ouvrir la plateforme dans un nouvel onglet →";
      el.appendChild(link);
    }
  }

  async function startCamera(video, statusEl) {
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraHelp(statusEl, null);
      return null;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play().catch(() => {});
      return stream;
    } catch (err) {
      cameraHelp(statusEl, err);
      return null;
    }
  }

  function stopCamera(video) {
    const stream = video.srcObject;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }

  function snapshot(video) {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  }

  async function post(url, payload) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify(payload),
        credentials: "same-origin",
      });
      let data = {};
      try { data = await res.json(); } catch (_) { /* non-JSON error page */ }
      return {
        ok: res.ok,
        code: res.status,
        status: data.status || (res.ok ? "ok" : "error"),
        name: data.name || "",
        reason: data.reason || "",
        message: data.message || (res.ok ? "OK" : "Erreur " + res.status),
      };
    } catch (_) {
      return { ok: false, code: 0, status: "error", name: "", message: "Serveur injoignable. Vérifiez la connexion." };
    }
  }

  // ---- Enrollment dialog (Members page) --------------------------------
  const dialog = document.getElementById("enroll-dialog");
  if (dialog) {
    const video = document.getElementById("enroll-video");
    const statusEl = document.getElementById("enroll-status");
    const consent = document.getElementById("enroll-consent");
    const capture = document.getElementById("enroll-capture");
    let memberId = null;

    document.querySelectorAll(".js-enroll").forEach((btn) => {
      btn.addEventListener("click", async () => {
        memberId = btn.dataset.member;
        document.getElementById("enroll-name").textContent = btn.dataset.name;
        consent.checked = false;
        setStatus(statusEl, "");
        dialog.showModal();
        const stream = await startCamera(video, statusEl);
        if (stream) {
          setStatus(statusEl, "Caméra active : visage centré, bonne lumière, puis « Capturer ».");
          speak("camera_on");
        } else {
          speak("camera_denied");
        }
      });
    });

    const close = () => { stopCamera(video); dialog.close(); };
    document.getElementById("enroll-cancel").addEventListener("click", close);
    dialog.addEventListener("cancel", () => stopCamera(video));

    capture.addEventListener("click", async () => {
      if (!consent.checked) {
        setStatus(statusEl, "Cochez la case de consentement avant d'enregistrer.", "error");
        return;
      }
      if (!video.srcObject) {
        setStatus(statusEl, "Caméra inactive.", "error");
        return;
      }
      capture.disabled = true;
      setStatus(statusEl, "Analyse du visage…");
      const url = capture.dataset.urlTemplate.replace(/0(\/enroll)$/, memberId + "$1");
      const result = await post(url, { image: snapshot(video), consent: true });
      setStatus(statusEl, result.message, result.ok ? "ok" : "error");
      capture.disabled = false;
      if (result.ok) speak("enrolled"); else speakResult(result);
      if (result.ok) setTimeout(() => { close(); window.location.reload(); }, 2200);
    });
  }

  // ---- Recognition kiosk (Access page) ---------------------------------
  const recVideo = document.getElementById("rec-video");
  if (recVideo) {
    const statusEl = document.getElementById("rec-status");
    const startBtn = document.getElementById("rec-start");
    const checkBtn = document.getElementById("rec-check");
    const autoBox = document.getElementById("rec-auto");
    const banner = document.getElementById("rec-banner");
    const bannerTitle = document.getElementById("rec-banner-title");
    const bannerText = document.getElementById("rec-banner-text");
    const live = document.getElementById("rec-live");
    let timer = null;
    let busy = false;

    const TITLES = {
      granted: "ACCÈS AUTORISÉ",
      expired: "ABONNEMENT EXPIRÉ",
      unknown: "VISAGE INCONNU",
      no_face: "En attente d'un visage…",
      multi_face: "Une personne à la fois",
      error: "Erreur",
      idle: "Caméra inactive",
      scanning: "Analyse en cours…",
    };

    function showBanner(status, text) {
      banner.className = "banner banner-" + status;
      bannerTitle.textContent = TITLES[status] || status;
      bannerText.textContent = text || "";
    }

    function pushLive(result) {
      if (!["granted", "expired", "unknown"].includes(result.status)) return;
      const li = document.createElement("li");
      li.className = "live-" + result.status;
      const time = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      li.textContent = time + " — " + (result.name || "Inconnu") + " — " + TITLES[result.status];
      live.prepend(li);
      while (live.children.length > 6) live.removeChild(live.lastChild);
    }

    async function check() {
      if (busy || !recVideo.srcObject) return null;
      busy = true;
      checkBtn.disabled = true;
      const result = await post(checkBtn.dataset.url, { image: snapshot(recVideo) });
      busy = false;
      checkBtn.disabled = !recVideo.srcObject;
      showBanner(result.status, result.message);
      setStatus(statusEl, result.status === "no_face" ? "" : result.message, result.ok ? "ok" : (result.status === "no_face" ? "" : "error"));
      pushLive(result);
      speakResult(result);
      return result;
    }

    function stopAuto() {
      if (timer) clearTimeout(timer);
      timer = null;
    }

    async function loop() {
      timer = null;
      if (!autoBox.checked || !recVideo.srcObject) return;
      let delay = 1500;
      if (!document.hidden) {
        const result = await check();
        if (result) {
          if (result.status === "granted" || result.status === "expired" || result.status === "unknown") delay = 3000;
          else if (result.code === 429) delay = 15000;
          else if (result.status === "error") delay = 5000;
        }
      }
      if (autoBox.checked && recVideo.srcObject) timer = setTimeout(loop, delay);
    }

    startBtn.addEventListener("click", async () => {
      if (recVideo.srcObject) {
        stopAuto();
        autoBox.checked = false;
        autoBox.disabled = true;
        stopCamera(recVideo);
        startBtn.textContent = "Activer la caméra";
        checkBtn.disabled = true;
        showBanner("idle", "Cliquez sur « Activer la caméra ».");
        setStatus(statusEl, "");
        speak("camera_off");
        return;
      }
      showBanner("scanning", "Demande d'autorisation…");
      const stream = await startCamera(recVideo, statusEl);
      if (stream) {
        startBtn.textContent = "Couper la caméra";
        checkBtn.disabled = false;
        autoBox.disabled = false;
        showBanner("no_face", "Placez le visage au centre de l'image.");
        setStatus(statusEl, "Caméra active. Cliquez sur « Vérifier maintenant » ou activez le mode automatique.");
        speak("camera_on");
      } else {
        showBanner("error", "Caméra indisponible.");
        speak("camera_denied");
      }
    });

    checkBtn.addEventListener("click", () => { showBanner("scanning", ""); check(); });

    autoBox.addEventListener("change", () => {
      stopAuto();
      if (autoBox.checked) {
        setStatus(statusEl, "Mode automatique actif : les visages sont vérifiés toutes les 1,5 s.");
        speak("auto_on");
        lastSpoken.clear();
        loop();
      } else {
        setStatus(statusEl, "Mode automatique arrêté.");
        speak("auto_off");
      }
    });

    window.addEventListener("pagehide", () => { stopAuto(); stopCamera(recVideo); });
  }
})();
