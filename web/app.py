import base64
import hmac
import io
import json
import os
import secrets
import sqlite3
import time
from collections import defaultdict, deque
from datetime import date, datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from flask import Flask, abort, flash, g, jsonify, make_response, redirect, render_template, request, session, url_for
from flask.sessions import SecureCookieSessionInterface
from PIL import Image, UnidentifiedImageError
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

# One platform, four target segments. Each sector drives vocabulary, KPIs and access rules.
SECTORS = {
    "fitness": {"label": "Salles de sport & fitness", "short": "Sport", "person": "membre", "people": "membres", "access": "Abonnement", "entry": "Passage", "entries": "Passages", "manual": "Passage manuel", "rule": None,
                "pitch": "Fini les cartes prêtées aux amis : le membre entre avec son visage."},
    "office": {"label": "PME & bureaux", "short": "Bureau", "person": "employé", "people": "employés", "access": "Contrat", "entry": "Pointage", "entries": "Pointages", "manual": "Pointage manuel", "rule": "attendance",
               "pitch": "Pointage quotidien automatique, calcul des retards, zéro triche entre collègues."},
    "coworking": {"label": "Coworking & centres de formation", "short": "Coworking", "person": "client", "people": "clients", "access": "Accès payé", "entry": "Entrée", "entries": "Entrées", "manual": "Entrée manuelle", "rule": None,
                  "pitch": "Accès selon le temps payé et nombre exact de personnes présentes."},
    "canteen": {"label": "Cantines & écoles privées", "short": "Cantine", "person": "inscrit", "people": "inscrits", "access": "Inscription", "entry": "Repas", "entries": "Repas", "manual": "Repas manuel", "rule": "one_per_day",
                "pitch": "Un repas par personne et par jour, présences instantanées."},
}
LEGACY_SECTORS = {"education": "canteen", "enterprise": "office", "leisure": "fitness"}
TIMEZONES = ["Africa/Algiers", "Africa/Casablanca", "Africa/Tunis", "Africa/Cairo", "Africa/Lagos", "Europe/Paris", "Asia/Dubai", "UTC"]
TOLERANCE = 0.5          # same threshold as the desktop app
MIN_FACE_HEIGHT = 50     # pixels, on a 640px-wide frame: rejects faces too far from the camera
DUPLICATE_WINDOW = 60    # seconds: one logged entry per member within this window
SCHEMA = """
CREATE TABLE IF NOT EXISTS organizations(id INTEGER PRIMARY KEY, name TEXT NOT NULL, sector TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Africa/Algiers', work_start TEXT NOT NULL DEFAULT '08:30', late_tolerance INTEGER NOT NULL DEFAULT 10);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), email TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', subscription_end TEXT NOT NULL, encoding TEXT, consent_at TEXT, UNIQUE(org_id,id));
CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, member_id INTEGER NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'granted', local_date TEXT, local_time TEXT, late INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(org_id,member_id) REFERENCES members(org_id,id) ON DELETE CASCADE);
"""
INDEXES = """
CREATE INDEX IF NOT EXISTS members_org ON members(org_id);
CREATE INDEX IF NOT EXISTS entries_org ON entries(org_id);
CREATE INDEX IF NOT EXISTS entries_day ON entries(org_id, local_date);
"""
MIGRATIONS = {
    "organizations": {"timezone": "TEXT NOT NULL DEFAULT 'Africa/Algiers'", "work_start": "TEXT NOT NULL DEFAULT '08:30'", "late_tolerance": "INTEGER NOT NULL DEFAULT 10"},
    "entries": {"status": "TEXT NOT NULL DEFAULT 'granted'", "local_date": "TEXT", "local_time": "TEXT", "late": "INTEGER NOT NULL DEFAULT 0"},
}


def cookie_secure_setting():
    """COOKIE_SECURE=0|1 forces the flag; anything else follows the scheme of each request."""
    raw = (os.environ.get("COOKIE_SECURE") or "").strip().lower()
    if raw in ("", "auto"):
        return "auto"
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    raise ValueError(f"COOKIE_SECURE doit valoir 0, 1 ou auto (reçu : {raw!r})")


class AdaptiveSessionInterface(SecureCookieSessionInterface):
    """COOKIE_SECURE=auto (the default): never ask for a Secure cookie the browser cannot use.

    A Secure flag is refused outside a secure context, which turned a successful login on a
    plain-HTTP kiosk (http://192.168.1.20:5000) into an endless bounce back to /login.
    """

    def get_cookie_secure(self, app):
        if app.config["ALLOW_EMBED"]:
            return True  # SameSite=None is only honoured together with Secure
        setting = app.config["SESSION_COOKIE_SECURE"]
        if setting == "auto":
            return bool(request.is_secure)
        return bool(setting)

    def get_cookie_samesite(self, app):
        setting = app.config["SESSION_COOKIE_SAMESITE"] or "Lax"
        if setting == "None" and not self.get_cookie_secure(app):
            return "Lax"  # without Secure the browser would drop the cookie altogether
        return setting


def tz_of(name):
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        return timezone.utc


def create_app(config=None):
    app = Flask(__name__, instance_relative_config=True)
    # All persistent files (database, generated session key) live next to WEB_DATABASE
    # when it is set (e.g. a Docker volume), otherwise in Flask's instance folder.
    database = os.environ.get("WEB_DATABASE") or str(Path(app.instance_path) / "web.db")
    data_dir = Path(database).parent
    data_dir.mkdir(parents=True, exist_ok=True)
    # Persist a random local key; production should inject its own SECRET_KEY.
    key_path = data_dir / "session.key"
    if not os.environ.get("SECRET_KEY") and not key_path.exists():
        try:
            fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(secrets.token_hex(32))
        except FileExistsError:
            pass
    # EMBED_PREVIEW=1: the app is shown inside another site's iframe (hosted preview).
    # Cookies must then be SameSite=None; Secure and framing must be allowed.
    embed = os.environ.get("EMBED_PREVIEW") == "1"
    app.config.update(
        SECRET_KEY=os.environ.get("SECRET_KEY") or key_path.read_text(),
        DATABASE=database,
        MAX_CONTENT_LENGTH=3 * 1024 * 1024,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="None" if embed else "Lax",
        # "auto" follows the scheme of each request; COOKIE_SECURE=1/0 forces it either way.
        SESSION_COOKIE_SECURE=True if embed else cookie_secure_setting(),
        PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
        ALLOW_EMBED=embed,
        # TRUST_PROXY=1 when running behind Cloudflare Tunnel / Nginx: real client IP and scheme
        TRUST_PROXY=os.environ.get("TRUST_PROXY") == "1",
    )
    if config:
        app.config.update(config)
    if app.config["TRUST_PROXY"]:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
    app.session_interface = AdaptiveSessionInterface()
    limits = defaultdict(deque)
    face_engine = {"available": None}

    def face_engine_available():
        if face_engine["available"] is None:
            try:
                import face_recognition  # noqa: F401  (loads dlib models once per process)
                face_engine["available"] = True
            except ImportError:
                face_engine["available"] = False
        return face_engine["available"]

    if os.environ.get("PRELOAD_FACE") == "1":
        # Warm the face engine at startup; with "gunicorn --preload" the ~100 MB of models
        # are loaded once and shared by all workers.
        face_engine_available()

    def db():
        if "db" not in g:
            g.db = sqlite3.connect(app.config["DATABASE"])
            g.db.row_factory = sqlite3.Row
            g.db.execute("PRAGMA foreign_keys=ON")
        return g.db

    with app.app_context():
        db().execute("PRAGMA journal_mode=WAL")
        db().executescript(SCHEMA)
        for table, columns in MIGRATIONS.items():
            existing = [r[1] for r in db().execute(f"PRAGMA table_info({table})")]
            for column, definition in columns.items():
                if column not in existing:
                    db().execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        db().executescript(INDEXES)  # after migrations: indexes may reference added columns
        for old, new in LEGACY_SECTORS.items():
            db().execute("UPDATE organizations SET sector=? WHERE sector=?", (new, old))
        # Backfill local date/time for entries created before timezone support.
        for row in db().execute("SELECT entries.id, entries.created_at, organizations.timezone FROM entries JOIN organizations ON organizations.id=entries.org_id WHERE local_date IS NULL").fetchall():
            local = datetime.fromisoformat(row["created_at"]).astimezone(tz_of(row["timezone"]))
            db().execute("UPDATE entries SET local_date=?, local_time=? WHERE id=?", (local.date().isoformat(), local.strftime("%H:%M"), row["id"]))
        db().commit()

    @app.teardown_appcontext
    def close_db(_error):
        if "db" in g:
            g.db.close()

    @app.before_request
    def protect():
        g.user = None
        g.sector = None
        if session.get("user_id"):
            g.user = db().execute("SELECT users.*, organizations.name AS org_name, organizations.sector, organizations.timezone, organizations.work_start, organizations.late_tolerance FROM users JOIN organizations ON organizations.id=users.org_id WHERE users.id=?", (session["user_id"],)).fetchone()
            if g.user:
                g.sector = SECTORS.get(g.user["sector"], SECTORS["fitness"])
        if "csrf" not in session:
            session["csrf"] = secrets.token_hex(32)
        if request.method == "POST":
            token = request.headers.get("X-CSRF-Token") or request.form.get("csrf", "")
            if not hmac.compare_digest(session["csrf"], token):
                abort(400, "Session expirée ou jeton de sécurité manquant. Rechargez la page.")

    @app.after_request
    def headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        csp = "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; form-action 'self'; base-uri 'self'"
        if not app.config["ALLOW_EMBED"]:
            csp += "; frame-ancestors 'self'"
        response.headers["Content-Security-Policy"] = csp
        response.headers["Permissions-Policy"] = "camera=(self)"
        if g.user or request.path in ("/login", "/signup"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.context_processor
    def context():
        return {"csrf": session.get("csrf"), "user": g.user, "sectors": SECTORS, "s": g.sector, "timezones": TIMEZONES}

    def client_ip_address():
        return (request.headers.get("CF-Connecting-IP") if app.config["TRUST_PROXY"] else None) or request.remote_addr

    def limited(bucket, count, seconds=60, key=None):
        # Single-process MVP protection. Use shared Redis limits for production.
        # Without a key: one bucket per visitor (or per logged-in user).
        key = key or (g.user["id"] if g.user else client_ip_address())
        now = time.monotonic()
        q = limits[key]
        while q and q[0] < now - seconds:
            q.popleft()
        if len(q) >= count:
            abort(429, "Trop de tentatives. Réessayez dans une minute.")
        q.append(now)

    def auth(fn):
        @wraps(fn)
        def inner(*args, **kwargs):
            if not g.user:
                if request.path.startswith("/api/"):
                    abort(401)
                return redirect(url_for("login"))
            return fn(*args, **kwargs)
        return inner

    def member(member_id):
        row = db().execute("SELECT * FROM members WHERE id=? AND org_id=?", (member_id, g.user["org_id"])).fetchone()
        if row is None:
            abort(404)
        return row

    def valid_date(value):
        try:
            return date.fromisoformat(value).isoformat()
        except (ValueError, TypeError):
            abort(400, "Date invalide.")

    def api_fail(code, status, message, **extra):
        abort(make_response(jsonify(status=status, message=message, **extra), code))

    def now_local():
        return datetime.now(tz_of(g.user["timezone"]))

    def today():
        return now_local().date().isoformat()

    def record(row, method):
        """Apply the sector's access rules and log the attempt.

        Returns a dict: granted, duplicate (same person within DUPLICATE_WINDOW),
        already (sector allows one entry per day and it was used), late, local_time.
        """
        local = now_local()
        day, hhmm = local.date().isoformat(), local.strftime("%H:%M")
        result = {"granted": row["subscription_end"] >= day, "duplicate": False, "already": False, "late": False, "local_time": hhmm, "late_minutes": 0}
        if not result["granted"]:
            status = "refused"
        else:
            now_utc = datetime.now(timezone.utc)
            since = (now_utc - timedelta(seconds=DUPLICATE_WINDOW)).isoformat()
            result["duplicate"] = db().execute("SELECT 1 FROM entries WHERE org_id=? AND member_id=? AND status='granted' AND created_at>=?", (g.user["org_id"], row["id"], since)).fetchone() is not None
            if result["duplicate"]:
                return result
            first_today = db().execute("SELECT 1 FROM entries WHERE org_id=? AND member_id=? AND status='granted' AND local_date=?", (g.user["org_id"], row["id"], day)).fetchone() is None
            if g.sector["rule"] == "one_per_day" and not first_today:
                result["already"] = True
                return result
            if g.sector["rule"] == "attendance" and first_today:
                h, m = (int(x) for x in (g.user["work_start"] or "08:30").split(":"))
                limit = local.replace(hour=h, minute=m, second=0, microsecond=0) + timedelta(minutes=g.user["late_tolerance"] or 0)
                if local > limit:
                    result["late"] = True
                    result["late_minutes"] = int((local - limit).total_seconds() // 60) + 1
            status = "granted"
        db().execute("INSERT INTO entries(org_id,member_id,actor_id,created_at,method,status,local_date,local_time,late) VALUES(?,?,?,?,?,?,?,?,?)", (g.user["org_id"], row["id"], g.user["id"], datetime.now(timezone.utc).isoformat(), method, status, day, hhmm, int(result["late"])))
        db().commit()
        return result

    @app.get("/healthz")
    def healthz():
        db().execute("SELECT 1").fetchone()
        return jsonify(status="ok", face_engine=face_engine_available())

    @app.get("/")
    def index():
        return render_template("landing.html")

    @app.route("/signup", methods=["GET", "POST"])
    def signup():
        if request.method == "POST":
            name = request.form.get("company", "").strip()
            email = request.form.get("email", "").strip().lower()
            password = request.form.get("password", "")
            sector = request.form.get("sector")
            if not name or len(name) > 100 or "@" not in email or len(email) > 254 or len(password) < 12 or len(password) > 256 or sector not in SECTORS:
                flash("Vérifiez les champs. Le mot de passe doit contenir 12 à 256 caractères.", "error")
            else:
                limited("signup", 5 if request.headers.get("CF-Connecting-IP") else 60, 3600)
                try:
                    org_id = db().execute("INSERT INTO organizations(name,sector) VALUES(?,?)", (name, sector)).lastrowid
                    uid = db().execute("INSERT INTO users(org_id,email,password) VALUES(?,?,?)", (org_id, email, generate_password_hash(password))).lastrowid
                    db().commit()
                    session.clear()
                    session.update(user_id=uid, permanent=True)
                    return redirect(url_for("dashboard"))
                except sqlite3.IntegrityError:
                    db().rollback()
                    flash("Impossible de créer ce compte avec ces informations. Essayez de vous connecter.", "error")
        return render_template("auth.html", signup=True, selected=request.args.get("sector", "fitness"))

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if request.method == "POST":
            email = request.form.get("email", "").strip().lower()
            visitor = client_ip_address() or ""
            # Guessing one account is throttled per account *and* visitor, so colleagues sharing
            # one NAT address cannot lock each other out; 10 logins in 5 minutes is nothing for a
            # hundred employees on Monday morning. Spraying many accounts stays limited per visitor.
            limited("login", 10 if request.headers.get("CF-Connecting-IP") else 100, 300, key=f"acct:{email}:{visitor}")
            limited("login", 60 if request.headers.get("CF-Connecting-IP") else 600, 300, key=f"ip:{visitor}")
            row = db().execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
            # Always do a password hash check to reduce account enumeration timing.
            fallback = generate_password_hash("not-a-real-password") if row is None else row["password"]
            if check_password_hash(fallback, request.form.get("password", "")) and row:
                session.clear()
                session.update(user_id=row["id"], permanent=True)
                return redirect(url_for("dashboard"))
            flash("Email ou mot de passe incorrect.", "error")
        return render_template("auth.html", signup=False)

    @app.post("/logout")
    def logout():
        session.clear()
        return redirect(url_for("index"))

    @app.get("/app")
    @app.get("/app/<page>")
    @auth
    def dashboard(page="overview"):
        if page not in ("overview", "members", "access", "settings"):
            abort(404)
        org, day = g.user["org_id"], today()
        rows = db().execute("SELECT id,name,email,subscription_end,consent_at FROM members WHERE org_id=? ORDER BY id DESC", (org,)).fetchall()
        logs = db().execute("SELECT entries.*,members.name FROM entries JOIN members ON members.id=entries.member_id AND members.org_id=entries.org_id WHERE entries.org_id=? ORDER BY entries.id DESC LIMIT 30", (org,)).fetchall()
        active = sum(r["subscription_end"] >= day for r in rows)

        def count(sql, *params):
            return db().execute(sql, (org, *params)).fetchone()[0]

        entries_today = count("SELECT COUNT(*) FROM entries WHERE org_id=? AND status='granted' AND local_date=?", day)
        refused_today = count("SELECT COUNT(*) FROM entries WHERE org_id=? AND status='refused' AND local_date=?", day)
        present_today = count("SELECT COUNT(DISTINCT member_id) FROM entries WHERE org_id=? AND status='granted' AND local_date=?", day)
        late_today = count("SELECT COUNT(*) FROM entries WHERE org_id=? AND late=1 AND local_date=?", day)
        s = g.sector
        if s["rule"] == "attendance":
            kpis = [("Employés", len(rows), ""), ("Présents aujourd'hui", present_today, "ok"), ("Absents", max(active - present_today, 0), "warn"), ("Retards aujourd'hui", late_today, "warn"), ("Pointages aujourd'hui", entries_today, "")]
        elif s["rule"] == "one_per_day":
            kpis = [("Inscrits", len(rows), ""), ("Repas servis aujourd'hui", entries_today, "ok"), ("Inscriptions actives", active, ""), ("Expirées", len(rows) - active, "warn"), ("Refus aujourd'hui", refused_today, "warn")]
        elif s["short"] == "Coworking":
            kpis = [("Clients", len(rows), ""), ("Présents aujourd'hui", present_today, "ok"), ("Accès actifs", active, ""), ("Expirés", len(rows) - active, "warn"), ("Refus aujourd'hui", refused_today, "warn")]
        else:
            kpis = [("Membres", len(rows), ""), ("Abonnements actifs", active, "ok"), ("Expirés", len(rows) - active, "warn"), ("Passages aujourd'hui", entries_today, ""), ("Refus aujourd'hui", refused_today, "warn")]
        attendance = []
        if s["rule"] == "attendance":
            first = {r["member_id"]: r for r in db().execute("SELECT member_id, MIN(local_time) AS arrival, MAX(late) AS late FROM entries WHERE org_id=? AND status='granted' AND local_date=? GROUP BY member_id", (org, day)).fetchall()}
            attendance = sorted(({"name": m["name"], "arrival": first[m["id"]]["arrival"] if m["id"] in first else None, "late": bool(first[m["id"]]["late"]) if m["id"] in first else False} for m in rows if m["subscription_end"] >= day), key=lambda a: (a["arrival"] is None, a["arrival"] or "", a["name"]))
        chart = []
        for offset in range(6, -1, -1):
            d = (now_local().date() - timedelta(days=offset)).isoformat()
            chart.append({"day": d[5:], "count": count("SELECT COUNT(*) FROM entries WHERE org_id=? AND status='granted' AND local_date=?", d)})
        return render_template("dashboard.html", page=page, members=rows, logs=logs, kpis=kpis, attendance=attendance, today=day, chart=chart, chart_max=max([c["count"] for c in chart] + [1]), enroll_id=request.args.get("enroll", type=int))

    @app.post("/members")
    @auth
    def add_member():
        name = request.form.get("name", "").strip()
        email = request.form.get("email", "").strip()
        if not name or len(name) > 100 or len(email) > 254:
            abort(400, "Nom requis (100 caractères maximum).")
        end = valid_date(request.form.get("subscription_end"))
        new_id = db().execute("INSERT INTO members(org_id,name,email,subscription_end) VALUES(?,?,?,?)", (g.user["org_id"], name, email, end)).lastrowid
        db().commit()
        if request.form.get("capture"):
            return redirect(url_for("dashboard", page="members", enroll=new_id))
        flash(f"{name} ajouté(e) à votre espace.", "success")
        return redirect(url_for("dashboard", page="members"))

    @app.post("/members/<int:member_id>/renew")
    @auth
    def renew(member_id):
        member(member_id)
        end = valid_date(request.form.get("subscription_end"))
        db().execute("UPDATE members SET subscription_end=? WHERE id=? AND org_id=?", (end, member_id, g.user["org_id"]))
        db().commit()
        flash(f"{g.sector['access']} mis à jour.", "success")
        return redirect(url_for("dashboard", page="members"))

    @app.post("/members/<int:member_id>/delete")
    @auth
    def delete(member_id):
        member(member_id)
        db().execute("DELETE FROM members WHERE id=? AND org_id=?", (member_id, g.user["org_id"]))
        db().commit()
        flash("Fiche, données biométriques et historique associé supprimés.", "success")
        return redirect(url_for("dashboard", page="members"))

    @app.post("/members/<int:member_id>/entry")
    @auth
    def manual_entry(member_id):
        row = member(member_id)
        if row["subscription_end"] < today():
            abort(409, f"{g.sector['access']} expiré(e) : refus.")
        result = record(row, "Manuel")
        if result["already"]:
            flash(f"{row['name']} : déjà enregistré(e) aujourd'hui (règle « un {g.sector['entry'].lower()} par jour »).", "error")
        elif result["duplicate"]:
            flash(f"{row['name']} : déjà enregistré(e) il y a moins d'une minute.", "success")
        else:
            flash(f"{g.sector['entry']} enregistré pour {row['name']} à {result['local_time']}" + (f" (retard de {result['late_minutes']} min)" if result["late"] else "") + ".", "success")
        return redirect(url_for("dashboard", page="access"))

    @app.post("/members/<int:member_id>/consent/revoke")
    @auth
    def revoke(member_id):
        member(member_id)
        db().execute("UPDATE members SET encoding=NULL,consent_at=NULL WHERE id=? AND org_id=?", (member_id, g.user["org_id"]))
        db().commit()
        flash("Données biométriques effacées.", "success")
        return redirect(url_for("dashboard", page="members"))

    @app.post("/settings")
    @auth
    def settings():
        name = request.form.get("company", "").strip()
        sector = request.form.get("sector")
        tz = request.form.get("timezone", "Africa/Algiers")
        work_start = request.form.get("work_start", "08:30")
        try:
            datetime.strptime(work_start, "%H:%M")
            tolerance = max(0, min(int(request.form.get("late_tolerance", 10)), 240))
        except ValueError:
            abort(400, "Heure ou tolérance invalide.")
        if not name or len(name) > 100 or sector not in SECTORS or tz not in TIMEZONES:
            abort(400)
        db().execute("UPDATE organizations SET name=?,sector=?,timezone=?,work_start=?,late_tolerance=? WHERE id=?", (name, sector, tz, work_start, tolerance, g.user["org_id"]))
        db().commit()
        flash("Votre espace a été personnalisé.", "success")
        return redirect(url_for("dashboard", page="settings"))

    def detect_face(single):
        """Decode the posted frame and return (encoding, face_recognition, numpy) for the main face."""
        try:
            import face_recognition
            import numpy as np
        except ImportError:
            api_fail(503, "error", "Moteur facial non installé sur ce serveur (voir README). Le contrôle manuel reste disponible.")
        body = request.get_json(silent=True) or {}
        try:
            raw = base64.b64decode(str(body.get("image", "")).split(",")[-1], validate=True)
            image = Image.open(io.BytesIO(raw))
            if image.width * image.height > 4_000_000:
                api_fail(400, "error", "Image trop grande.")
            image = image.convert("RGB")
            image.thumbnail((640, 480))
            frame = np.ascontiguousarray(np.array(image))
            boxes = face_recognition.face_locations(frame)
        except (ValueError, UnidentifiedImageError, OSError, Image.DecompressionBombError):
            api_fail(400, "error", "Image invalide.")
        if not boxes:
            api_fail(422, "no_face", "Aucun visage détecté. Placez-vous face à la caméra.", reason="none")
        if single and len(boxes) > 1:
            api_fail(422, "multi_face", "Plusieurs visages détectés : une seule personne à la fois pour l’enregistrement.")
        top, right, bottom, left = max(boxes, key=lambda b: (b[2] - b[0]) * (b[1] - b[3]))
        if bottom - top < MIN_FACE_HEIGHT:
            api_fail(422, "no_face", "Visage trop éloigné : approchez-vous de la caméra.", reason="far")
        encoding = face_recognition.face_encodings(frame, known_face_locations=[(top, right, bottom, left)])[0]
        return encoding, face_recognition, np

    @app.post("/api/members/<int:member_id>/enroll")
    @auth
    def enroll(member_id):
        row = member(member_id)
        if (request.get_json(silent=True) or {}).get("consent") is not True:
            api_fail(400, "error", "Consentement explicite requis.")
        limited("enroll", 30)
        encoding, _, _ = detect_face(single=True)
        db().execute("UPDATE members SET encoding=?,consent_at=? WHERE id=? AND org_id=?", (json.dumps(encoding.tolist()), datetime.now(timezone.utc).isoformat(), member_id, g.user["org_id"]))
        db().commit()
        return jsonify(status="ok", message=f"Visage de {row['name']} enregistré avec consentement.")

    @app.post("/api/recognize")
    @auth
    def recognize():
        limited("recognize", 90)
        encoding, engine, np = detect_face(single=False)
        rows = db().execute("SELECT * FROM members WHERE org_id=? AND encoding IS NOT NULL AND consent_at IS NOT NULL", (g.user["org_id"],)).fetchall()
        if not rows:
            api_fail(404, "unknown", f"Aucun visage enregistré dans votre espace : enregistrez d’abord vos {g.sector['people']} (page {g.sector['people'].capitalize()}).")
        distances = engine.face_distance([np.array(json.loads(r["encoding"])) for r in rows], encoding)
        idx = int(np.argmin(distances))
        if distances[idx] > TOLERANCE:
            api_fail(404, "unknown", "Visage non reconnu : accès refusé.")
        row = rows[idx]
        name, s = row["name"], g.sector
        result = record(row, "Facial")
        if not result["granted"]:
            api_fail(403, "expired", f"{name} : {s['access'].lower()} expiré(e) le {row['subscription_end']}, accès refusé.", name=name)
        if result["already"]:
            api_fail(409, "already", f"{name} : {s['entry'].lower()} déjà enregistré aujourd'hui.", name=name)
        if s["rule"] == "attendance":
            message = f"{name} : pointage enregistré à {result['local_time']}" + (f" — retard de {result['late_minutes']} min" if result["late"] else "") + "."
        elif s["rule"] == "one_per_day":
            message = f"{name} : repas enregistré. Bon appétit !"
        else:
            message = f"{name} : accès autorisé."
        if result["duplicate"]:
            message = f"{name} : déjà enregistré(e) il y a moins d'une minute."
        return jsonify(status="granted", name=name, message=message, late=result["late"], local_time=result["local_time"], confidence=round(float(1 - distances[idx]), 2))

    @app.errorhandler(400)
    @app.errorhandler(401)
    @app.errorhandler(403)
    @app.errorhandler(404)
    @app.errorhandler(409)
    @app.errorhandler(413)
    @app.errorhandler(422)
    @app.errorhandler(429)
    @app.errorhandler(503)
    def error(exc):
        if request.path.startswith("/api/"):
            return jsonify(status="error", message=exc.description), exc.code
        return render_template("error.html", error=exc), exc.code

    return app
