// Notifications de la plateforme : un seul composant pour l'espace entreprise et pour le kiosque.
// Pas une bannière qui disparaît au bout de 6 secondes : une pile de fiches, une icône, une durée
// lisible, une action, un son court, et un mode « héros » plein écran pour le résultat d'un passage.
//
// API :
//   Toast.show({ kind, title, body, meta, action, duration, sticky, hero, sound })
//   Toast.passage({ status, name, message, device, time, confidence, person })   // résultat du kiosque
//   Toast.system({ ok, title, body })        // caméra, moteur, réseau, appareil
//   Toast.dismiss(node) / Toast.clear()
// Les éléments sont construits avec l'API DOM : aucune chaîne `style=` n'est injectée (la page est
// servie avec `style-src 'self'`), et les hauteurs/durées se règlent par propriété ou variable.
window.Toast = (function () {
  "use strict";

  const MAX_VISIBLE = 4;
  const ICONS = {
    success: "M2.5 8.5l3.2 3.2L13.5 4",
    granted: "M2.5 8.5l3.2 3.2L13.5 4",
    error: "M4 4l8 8M12 4l-8 8",
    denied: "M8 1.6a6.4 6.4 0 100 12.8 6.4 6.4 0 000-12.8zM3.6 12.4L12.4 3.6",
    warn: "M8 2.2L14.4 13.4H1.6L8 2.2zM8 6.4v3.2M8 11.4v.6",
    info: "M8 1.6a6.4 6.4 0 100 12.8 6.4 6.4 0 000-12.8zM8 7.2v4.4M8 4.8v.6",
    device: "M2.4 4.4h11.2v6.4H2.4zM5.6 12.8h4.8M8 10.8v2",
    camera: "M2 4.4h7.2v6.4H2zM9.2 7.2l4-2.2v5.2l-4-2.2",
  };
  const DEFAULT_TITLE = {
    success: "C'est enregistré", error: "Ça n'a pas marché", warn: "Attention", info: "Information",
    granted: "Accès autorisé", denied: "Accès refusé", device: "Appareil", camera: "Caméra",
  };

  let root = null;
  let muted = false;
  try { muted = localStorage.getItem("faceid.sound") === "off"; } catch (_) { /* défaut : son actif */ }
  let audio = null;
  const live = [];   // les fiches actuellement affichées

  function host() {
    if (root && root.isConnected) return root;
    root = document.createElement("div");
    root.className = "toasts";
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Notifications");
    (document.body || document.documentElement).appendChild(root);
    return root;
  }

  const text = (parent, tag, cls, value) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    node.textContent = value == null ? "" : String(value);
    parent.appendChild(node);
    return node;
  };

  function icon(kind) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.7");
    svg.setAttribute("stroke-linecap", "round");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", ICONS[kind] || ICONS.info);
    svg.appendChild(path);
    return svg;
  }

  // Un son très court, synthétisé : pas de fichier à charger, et il ne marche jamais sur les
  // oreilles d'un haut-parleur d'application. Granté = deux notes montantes, refus = deux graves.
  function jingle(kind) {
    if (muted) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const notes = kind === "granted" ? [659.3, 880] : kind === "denied" || kind === "error" ? [233, 174.6] : kind === "warn" ? [415.3] : [523.3];
    try {
      audio = audio || new Ctx();
      if (audio.state === "suspended") audio.resume().catch(() => {});
      notes.forEach((freq, index) => {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const at = audio.currentTime + index * 0.13;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.16, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
        osc.connect(gain).connect(audio.destination);
        osc.start(at);
        osc.stop(at + 0.24);
      });
    } catch (_) { /* pas de sortie audio : la fiche suffit */ }
  }

  // Une fiche qui sort déjà ne doit jamais rester comptée dans la pile : sinon la boucle qui
  // borne le nombre de fiches visibles (au-delà de MAX_VISIBLE) ne se termine plus et la page
  // entière se fige — l'exact opposé d'une notification.
  function dismiss(node, immediate) {
    if (!node) return;
    const index = live.indexOf(node);
    if (index >= 0) live.splice(index, 1);
    if (node.dataset.closing === "1") { if (immediate) node.remove(); return; }
    node.dataset.closing = "1";
    const drop = () => {
      node.remove();
      if (node.timer) clearTimeout(node.timer);
    };
    if (immediate || node.dataset.hero === "1") return drop();
    node.classList.add("toast-out");
    setTimeout(drop, 220);
  }

  function arm(node, ms) {
    if (!ms) return;
    node.dataset.ms = String(ms);
    node.timer = setTimeout(() => dismiss(node), ms);
  }

  // Au survol (ou au doigt) la fiche retient son souffle : on lit sans courir.
  function keepAlive(node) {
    const hold = () => { if (node.timer) { clearTimeout(node.timer); node.timer = null; node.classList.add("held"); } };
    const resume = () => {
      if (!node.timer && node.dataset.ms) {
        const left = Math.max(1200, Number(node.dataset.ms) - (Date.now() - Number(node.dataset.since || Date.now())));
        node.timer = setTimeout(() => dismiss(node), left);
        node.classList.remove("held");
      }
    };
    node.addEventListener("mouseenter", hold);
    node.addEventListener("mouseleave", resume);
    node.addEventListener("focusin", hold);
    node.addEventListener("focusout", resume);
    node.addEventListener("touchstart", hold, { passive: true });
  }

  function show(options) {
    const opts = options || {};
    const kind = ICONS[opts.kind] ? opts.kind : "info";
    // Deux pannes identiques = une seule fiche à l'écran (un poste qui retente la caméra le
    // sait toutes les quelques secondes, l'opérateur n'a pas à lire la même phrase quatre fois).
    if (opts.tag) {
      const twin = live.find((node) => node.dataset.tag === opts.tag);
      if (twin) dismiss(twin, true);
    }
    const card = document.createElement("article");
    card.className = "toast toast-" + kind + (opts.hero ? " toast-hero" : "");
    if (opts.tag) card.dataset.tag = opts.tag;
    if (opts.verdict) card.dataset.verdict = opts.verdict;
    card.setAttribute("role", opts.sticky ? "alert" : "status");
    card.dataset.since = String(Date.now());
    card.dataset.hero = opts.hero ? "1" : "0";

    const head = text(card, "div", "toast-head");
    const mark = text(head, "span", "toast-icon");
    mark.appendChild(icon(kind));
    text(head, "h3", "toast-title", opts.title || DEFAULT_TITLE[kind] || kind);
    if (opts.meta) text(head, "time", "toast-meta", opts.meta);
    const close = text(head, "button", "toast-close");
    close.type = "button";
    close.setAttribute("aria-label", "Fermer cette notification");
    close.textContent = "×";
    close.addEventListener("click", () => dismiss(card, true));

    if (opts.body) text(card, "p", "toast-body", opts.body);

    if (opts.action && opts.action.label) {
      const foot = text(card, "div", "toast-foot");
      const button = text(foot, "button", "btn btn-ghost btn-sm", opts.action.label);
      button.type = "button";
      button.addEventListener("click", () => {
        try { opts.action.onClick && opts.action.onClick(); } finally { dismiss(card, true); }
      });
    }

    const duration = opts.sticky ? 0 : Math.max(1200, Number(opts.duration) || (kind === "error" || kind === "denied" ? 9000 : 4800));
    const drain = text(card, "i", "toast-drain");
    if (duration) {
      drain.style.setProperty("--dur", duration + "ms");
      drain.style.animationName = "toast-drain";
      card.addEventListener("mouseenter", () => { drain.style.animationPlayState = "paused"; });
      card.addEventListener("mouseleave", () => { drain.style.animationPlayState = "running"; });
    }

    const stack = host();
    stack.insertBefore(card, stack.firstChild);
    live.unshift(card);
    keepAlive(card);
    while (live.length > MAX_VISIBLE) dismiss(live[live.length - 1], true);   // la 5e fiche sort net, sans file d'attente animée
    if (duration) arm(card, duration);
    if (opts.sound !== false) jingle(kind);
    return card;
  }

  // --- Vocabulaire métier : un passage, une machine, un réseau -----------------
  const VERDICT = {
    granted: { kind: "granted", label: "Accès autorisé" },
    already: { kind: "info", label: "Déjà enregistré aujourd'hui" },
    expired: { kind: "warn", label: "Expiré" },
    unknown: { kind: "denied", label: "Visage inconnu" },
    no_face: { kind: "info", label: "En attente" },
    multi_face: { kind: "info", label: "Une personne à la fois" },
    error: { kind: "error", label: "Analyse impossible" },
  };
  function passage(result) {
    const r = result || {};
    const verdict = VERDICT[r.status] || VERDICT.error;
    const bits = [];
    if (r.device) bits.push(r.device);
    if (typeof r.confidence === "number") bits.push(Math.round(r.confidence * 100) + " % de ressemblance");
    return show({
      kind: verdict.kind,
      verdict: r.status,
      title: r.name ? r.name : verdict.label,
      body: (r.message || (r.status === "granted" ? (r.person || "Personne") + " est entré(e)." : verdict.label)) + (bits.length ? " · " + bits.join(" · ") : ""),
      meta: r.time ? String(r.time).slice(0, 8) : new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      action: r.status === "granted" && r.member_id ? { label: "Voir la fiche", onClick: () => { location.hash = "members"; } } : null,
      // `hero` à false dans l'espace admin : la fiche se range dans la pile, elle n'écrase pas l'écran.
      hero: r.hero === false ? false : (r.status === "granted" || r.status === "unknown" || r.status === "expired"),
      duration: r.duration || 6500,
      sound: r.sound,
    });
  }
  function system(report) {
    const r = report || {};
    return show({
      kind: r.ok === false ? (r.kind === "camera" ? "warn" : "error") : "success",
      tag: r.kind,
      title: r.title || (r.ok === false ? "Matériel à surveiller" : "Tout est prêt"),
      body: r.body || r.message || "",
      meta: r.meta,
      action: r.action,
      duration: r.duration || 5200,
      sound: r.sound,
    });
  }
  return {
    show, system, passage, dismiss,
    clear() { [...live].forEach((node) => dismiss(node, true)); },
    count: () => live.length,
    muted(value) {
      if (value === undefined) return muted;
      muted = Boolean(value);
      try { localStorage.setItem("faceid.sound", muted ? "off" : "on"); } catch (_) { /* ignore */ }
      return muted;
    },
    // Une page laissée ouverte sur une borne ne doit jamais rester muette parce que
    // le navigateur attend un geste pour l'audio : on le capte une fois pour toutes.
    unlock() {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      try {
        audio = audio || new Ctx();
        if (audio.state === "suspended") audio.resume().catch(() => {});
      } catch (_) { /* pas d'audio de toute façon */ }
    },
  };
})();
