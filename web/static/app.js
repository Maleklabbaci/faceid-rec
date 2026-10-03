(function () {
  "use strict";

  const csrf = document.querySelector('input[name="csrf"]')?.value || "";

  // Confirm destructive forms
  document.querySelectorAll("form.js-confirm").forEach((form) => {
    form.addEventListener("submit", (event) => {
      if (!window.confirm(form.dataset.confirm || "Confirmer ?")) event.preventDefault();
    });
  });

  // ---- Camera helpers --------------------------------------------------
  async function startCamera(video, statusEl) {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus(statusEl, "Caméra non disponible dans ce navigateur (HTTPS requis).", "error");
      return null;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      video.srcObject = stream;
      await video.play().catch(() => {});
      return stream;
    } catch (err) {
      setStatus(statusEl, "Accès caméra refusé ou indisponible : " + err.message, "error");
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

  function setStatus(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.className = "status" + (kind ? " " + kind : "");
  }

  async function post(url, payload) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(payload),
      credentials: "same-origin",
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* non-JSON error page */ }
    return { ok: res.ok, message: data.message || (res.ok ? "OK" : "Erreur " + res.status) };
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
        await startCamera(video, statusEl);
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

  // ---- Recognition (Access page) ---------------------------------------
  const recVideo = document.getElementById("rec-video");
  if (recVideo) {
    const statusEl = document.getElementById("rec-status");
    const startBtn = document.getElementById("rec-start");
    const checkBtn = document.getElementById("rec-check");

    startBtn.addEventListener("click", async () => {
      if (recVideo.srcObject) {
        stopCamera(recVideo);
        startBtn.textContent = "Activer la caméra";
        checkBtn.disabled = true;
        return;
      }
      const stream = await startCamera(recVideo, statusEl);
      if (stream) {
        startBtn.textContent = "Couper la caméra";
        checkBtn.disabled = false;
        setStatus(statusEl, "Caméra active. Placez le visage au centre puis cliquez sur « Vérifier l'accès ».");
      }
    });

    checkBtn.addEventListener("click", async () => {
      checkBtn.disabled = true;
      setStatus(statusEl, "Vérification…");
      const result = await post(checkBtn.dataset.url, { image: snapshot(recVideo) });
      setStatus(statusEl, result.message, result.ok ? "ok" : "error");
      checkBtn.disabled = false;
    });

    window.addEventListener("pagehide", () => stopCamera(recVideo));
  }
})();
