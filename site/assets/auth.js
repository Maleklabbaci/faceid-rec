(function () {
  "use strict";
  const form = document.getElementById("auth-form");
  const flash = document.getElementById("flash");
  const select = document.getElementById("sector-select");
  const wanted = new URLSearchParams(location.search).get("sector");
  if (select && wanted && [...select.options].some((o) => o.value === wanted)) select.value = wanted;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    flash.hidden = true;
    const payload = Object.fromEntries(new FormData(form).entries());
    try {
      const res = await fetch(form.dataset.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { location.href = data.redirect || "/app"; return; }
      flash.textContent = data.message || "Erreur " + res.status;
      flash.className = "flash flash-error";
      flash.hidden = false;
    } catch (_) {
      flash.textContent = "Serveur injoignable. Vérifiez la connexion.";
      flash.className = "flash flash-error";
      flash.hidden = false;
    }
    button.disabled = false;
  });
})();
