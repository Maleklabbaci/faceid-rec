(function () {
  "use strict";

  const csrf = document.querySelector('input[name="csrf"]')?.value || "";
  const embedded = window.self !== window.top;

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
        if (stream) setStatus(statusEl, "Caméra active : visage centré, bonne lumière, puis « Capturer ».");
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
      if (result.ok) setTimeout(() => { close(); window.location.reload(); }, 1200);
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
      } else {
        showBanner("error", "Caméra indisponible.");
      }
    });

    checkBtn.addEventListener("click", () => { showBanner("scanning", ""); check(); });

    autoBox.addEventListener("change", () => {
      stopAuto();
      if (autoBox.checked) {
        setStatus(statusEl, "Mode automatique actif : les visages sont vérifiés toutes les 1,5 s.");
        loop();
      } else {
        setStatus(statusEl, "Mode automatique arrêté.");
      }
    });

    window.addEventListener("pagehide", () => { stopAuto(); stopCamera(recVideo); });
  }
})();
