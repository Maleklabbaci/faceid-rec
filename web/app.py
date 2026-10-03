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

from flask import Flask, abort, flash, g, jsonify, redirect, render_template, request, session, url_for
from PIL import Image, UnidentifiedImageError
from werkzeug.security import check_password_hash, generate_password_hash

SECTORS = {"fitness": "Sport & fitness", "education": "Éducation", "coworking": "Coworking", "enterprise": "Entreprises", "leisure": "Loisirs"}
SCHEMA = """
CREATE TABLE IF NOT EXISTS organizations(id INTEGER PRIMARY KEY, name TEXT NOT NULL, sector TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), email TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', subscription_end TEXT NOT NULL, encoding TEXT, consent_at TEXT, UNIQUE(org_id,id));
CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, member_id INTEGER NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, method TEXT NOT NULL, FOREIGN KEY(org_id,member_id) REFERENCES members(org_id,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS members_org ON members(org_id);
CREATE INDEX IF NOT EXISTS entries_org ON entries(org_id);
"""


def create_app(config=None):
    app = Flask(__name__, instance_relative_config=True)
    Path(app.instance_path).mkdir(parents=True, exist_ok=True)
    # Persist a random local key; production must inject its own secret.
    key_path = Path(app.instance_path) / "session.key"
    if not os.environ.get("SECRET_KEY") and not key_path.exists():
        try:
            fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(secrets.token_hex(32))
        except FileExistsError:
            pass
    app.config.update(SECRET_KEY=os.environ.get("SECRET_KEY") or key_path.read_text(), DATABASE=os.environ.get("WEB_DATABASE") or str(Path(app.instance_path) / "web.db"), MAX_CONTENT_LENGTH=3 * 1024 * 1024, SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax", SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "1") == "1", PERMANENT_SESSION_LIFETIME=timedelta(hours=8))
    if config:
        app.config.update(config)
    limits = defaultdict(deque)

    def db():
        if "db" not in g:
            g.db = sqlite3.connect(app.config["DATABASE"])
            g.db.row_factory = sqlite3.Row
            g.db.execute("PRAGMA foreign_keys=ON")
        return g.db

    with app.app_context():
        db().execute("PRAGMA journal_mode=WAL")
        db().executescript(SCHEMA)
        db().commit()

    @app.teardown_appcontext
    def close_db(_error):
        if "db" in g:
            g.db.close()

    @app.before_request
    def protect():
        g.user = None
        if session.get("user_id"):
            g.user = db().execute("SELECT users.*, organizations.name AS org_name, organizations.sector FROM users JOIN organizations ON organizations.id=users.org_id WHERE users.id=?", (session["user_id"],)).fetchone()
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
        response.headers["Content-Security-Policy"] = "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'; form-action 'self'; base-uri 'self'"
        response.headers["Permissions-Policy"] = "camera=(self)"
        if g.user or request.path in ("/login", "/signup"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.context_processor
    def context():
        return {"csrf": session.get("csrf"), "user": g.user, "sectors": SECTORS}

    def limited(bucket, count, seconds=60):
        # Single-process MVP protection. Use shared Redis limits for production.
        key = (bucket, g.user["id"] if g.user else request.remote_addr)
        now = time.monotonic()
        q = limits[key]
        while q and q[0] < now - seconds:
            q.popleft()
        if len(q) >= count:
            abort(429, "Trop de tentatives. Réessayez plus tard.")
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

    def entry(row, method):
        if row["subscription_end"] < date.today().isoformat():
            abort(409, "Abonnement expiré : entrée refusée.")
        db().execute("INSERT INTO entries(org_id,member_id,actor_id,created_at,method) VALUES(?,?,?,?,?)", (g.user["org_id"], row["id"], g.user["id"], datetime.now(timezone.utc).isoformat(), method))
        db().commit()

    @app.get("/")
    def index():
        return render_template("landing.html")

    @app.route("/signup", methods=["GET", "POST"])
    def signup():
        if request.method == "POST":
            limited("signup", 5, 3600)
            name = request.form.get("company", "").strip()
            email = request.form.get("email", "").strip().lower()
            password = request.form.get("password", "")
            sector = request.form.get("sector")
            if not name or len(name) > 100 or "@" not in email or len(email) > 254 or len(password) < 12 or len(password) > 256 or sector not in SECTORS:
                flash("Vérifiez les champs. Le mot de passe doit contenir 12 à 256 caractères.", "error")
            else:
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
        return render_template("auth.html", signup=True)

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if request.method == "POST":
            limited("login", 10, 300)
            row = db().execute("SELECT * FROM users WHERE email=?", (request.form.get("email", "").strip().lower(),)).fetchone()
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
        rows = db().execute("SELECT id,name,email,subscription_end,consent_at FROM members WHERE org_id=? ORDER BY id DESC", (g.user["org_id"],)).fetchall()
        logs = db().execute("SELECT entries.*,members.name FROM entries JOIN members ON members.id=entries.member_id AND members.org_id=entries.org_id WHERE entries.org_id=? ORDER BY entries.id DESC LIMIT 30", (g.user["org_id"],)).fetchall()
        today = date.today().isoformat()
        active = sum(r["subscription_end"] >= today for r in rows)
        visits = db().execute("SELECT COUNT(*) FROM entries WHERE org_id=? AND substr(created_at,1,10)=?", (g.user["org_id"], today)).fetchone()[0]
        chart = []
        for offset in range(6, -1, -1):
            day = (date.today() - timedelta(days=offset)).isoformat()
            n = db().execute("SELECT COUNT(*) FROM entries WHERE org_id=? AND substr(created_at,1,10)=?", (g.user["org_id"], day)).fetchone()[0]
            chart.append({"day": day[5:], "count": n})
        return render_template("dashboard.html", page=page, members=rows, logs=logs, active=active, visits=visits, today=today, chart=chart, chart_max=max([c["count"] for c in chart] + [1]))

    @app.post("/members")
    @auth
    def add_member():
        name = request.form.get("name", "").strip()
        email = request.form.get("email", "").strip()
        if not name or len(name) > 100 or len(email) > 254:
            abort(400, "Nom requis (100 caractères maximum).")
        end = valid_date(request.form.get("subscription_end"))
        db().execute("INSERT INTO members(org_id,name,email,subscription_end) VALUES(?,?,?,?)", (g.user["org_id"], name, email, end))
        db().commit()
        flash("Membre ajouté à votre espace.", "success")
        return redirect(url_for("dashboard", page="members"))

    @app.post("/members/<int:member_id>/renew")
    @auth
    def renew(member_id):
        member(member_id)
        end = valid_date(request.form.get("subscription_end"))
        db().execute("UPDATE members SET subscription_end=? WHERE id=? AND org_id=?", (end, member_id, g.user["org_id"]))
        db().commit()
        flash("Abonnement mis à jour.", "success")
        return redirect(url_for("dashboard", page="members"))

    @app.post("/members/<int:member_id>/delete")
    @auth
    def delete(member_id):
        member(member_id)
        db().execute("DELETE FROM members WHERE id=? AND org_id=?", (member_id, g.user["org_id"]))
        db().commit()
        flash("Membre, données biométriques et historique associé supprimés.", "success")
        return redirect(url_for("dashboard", page="members"))

    @app.post("/members/<int:member_id>/entry")
    @auth
    def manual_entry(member_id):
        entry(member(member_id), "Manuel")
        flash("Entrée enregistrée par l’administrateur.", "success")
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
        if not name or len(name) > 100 or sector not in SECTORS:
            abort(400)
        db().execute("UPDATE organizations SET name=?,sector=? WHERE id=?", (name, sector, g.user["org_id"]))
        db().commit()
        flash("Votre espace a été personnalisé.", "success")
        return redirect(url_for("dashboard", page="settings"))

    def face_encoding():
        limited("face", 12)
        try:
            import face_recognition
            import numpy as np
        except ImportError:
            abort(503, "Module facial non installé sur ce serveur. Le contrôle manuel reste disponible.")
        body = request.get_json(silent=True) or {}
        try:
            raw = base64.b64decode(body.get("image", "").split(",")[-1], validate=True)
            image = Image.open(io.BytesIO(raw))
            if image.width * image.height > 4_000_000:
                abort(400, "Image trop grande.")
            image = image.convert("RGB")
            image.thumbnail((640, 480))
            encodings = face_recognition.face_encodings(np.array(image))
        except (ValueError, UnidentifiedImageError, OSError, Image.DecompressionBombError):
            abort(400, "Image invalide.")
        if len(encodings) != 1:
            abort(400, "Présentez exactement un visage face à la caméra.")
        return encodings[0], face_recognition, np

    @app.post("/api/members/<int:member_id>/enroll")
    @auth
    def enroll(member_id):
        member(member_id)
        if (request.get_json(silent=True) or {}).get("consent") is not True:
            abort(400, "Consentement explicite requis.")
        encoding, _, _ = face_encoding()
        db().execute("UPDATE members SET encoding=?,consent_at=? WHERE id=? AND org_id=?", (json.dumps(encoding.tolist()), datetime.now(timezone.utc).isoformat(), member_id, g.user["org_id"]))
        db().commit()
        return jsonify(message="Visage enregistré avec consentement (version du texte : MVP-1).")

    @app.post("/api/recognize")
    @auth
    def recognize():
        encoding, engine, np = face_encoding()
        rows = db().execute("SELECT * FROM members WHERE org_id=? AND encoding IS NOT NULL AND consent_at IS NOT NULL", (g.user["org_id"],)).fetchall()
        if not rows:
            abort(404, "Aucun visage enregistré dans votre entreprise.")
        distances = engine.face_distance([np.array(json.loads(r["encoding"])) for r in rows], encoding)
        idx = int(np.argmin(distances))
        if distances[idx] > 0.5:
            abort(404, "Visage non reconnu.")
        entry(rows[idx], "Facial · test")
        return jsonify(message=f"{rows[idx]['name']} : présence enregistrée. Aucune porte n’a été actionnée.")

    @app.errorhandler(400)
    @app.errorhandler(401)
    @app.errorhandler(404)
    @app.errorhandler(409)
    @app.errorhandler(413)
    @app.errorhandler(429)
    @app.errorhandler(503)
    def error(exc):
        if request.path.startswith("/api/"):
            return jsonify(message=exc.description), exc.code
        return render_template("error.html", error=exc), exc.code

    return app
