import html
import re
from datetime import date, datetime, timedelta, timezone

import pytest

from web.app import create_app


@pytest.fixture
def app(tmp_path):
    application = create_app({"DATABASE": str(tmp_path / "test.db"), "SESSION_COOKIE_SECURE": False, "TESTING": True})

    class UnescapedResponse(application.response_class):
        """get_data(as_text=True) returns HTML-unescaped text so tests can assert French apostrophes."""

        def get_data(self, as_text=False):
            data = super().get_data(as_text=as_text)
            return html.unescape(data) if as_text else data

    application.response_class = UnescapedResponse
    return application


@pytest.fixture
def client(app):
    return app.test_client()


def csrf_of(client, path="/login"):
    html = client.get(path).get_data(as_text=True)
    return re.search(r'name="csrf" value="([0-9a-f]+)"', html).group(1)


def signup(client, email, company="Salle Olympia", sector="fitness", password="motdepasse-solide-123"):
    token = csrf_of(client, "/signup")
    return client.post("/signup", data={"csrf": token, "company": company, "email": email, "password": password, "sector": sector})


def add_member(client, name, end=None):
    token = csrf_of(client, "/app/members")
    end = end or date.today().isoformat()
    return client.post("/members", data={"csrf": token, "name": name, "subscription_end": end}, follow_redirects=True)


def member_ids(client):
    html = client.get("/app/members").get_data(as_text=True)
    return [int(m) for m in re.findall(r'/members/(\d+)/renew', html)]


def test_landing_and_auth_pages(client):
    assert client.get("/").status_code == 200
    assert "secteur" in client.get("/").get_data(as_text=True).lower()
    assert client.get("/app").status_code == 302  # redirect to login
    assert client.post("/api/recognize", json={}).status_code == 400  # CSRF before auth
    assert client.get("/signup").status_code == 200


def test_signup_login_logout(client):
    r = signup(client, "admin@olympia.dz")
    assert r.status_code == 302 and r.headers["Location"].endswith("/app")
    page = client.get("/app").get_data(as_text=True)
    assert "Salle Olympia" in page and "sector-fitness" in page

    token = csrf_of(client, "/app")
    client.post("/logout", data={"csrf": token})
    assert client.get("/app").status_code == 302

    token = csrf_of(client)
    bad = client.post("/login", data={"csrf": token, "email": "admin@olympia.dz", "password": "wrong"}, follow_redirects=True)
    assert "incorrect" in bad.get_data(as_text=True)
    good = client.post("/login", data={"csrf": token, "email": "ADMIN@olympia.dz", "password": "motdepasse-solide-123"})
    assert good.status_code == 302


def test_signup_validation(client):
    assert "12" in signup(client, "x@y.z", password="court").get_data(as_text=True)
    assert "Vérifiez" in signup(client, "x@y.z", sector="banque").get_data(as_text=True)
    signup(client, "dup@y.z")
    token = csrf_of(client, "/app")
    client.post("/logout", data={"csrf": token})
    assert "Impossible" in signup(client, "dup@y.z").get_data(as_text=True)


def test_csrf_required(client):
    signup(client, "a@b.c")
    assert client.post("/members", data={"name": "X", "subscription_end": "2030-01-01"}).status_code == 400
    assert client.post("/members", data={"csrf": "bad", "name": "X", "subscription_end": "2030-01-01"}).status_code == 400


def test_member_lifecycle_and_subscription(client):
    signup(client, "a@b.c")
    future = (date.today() + timedelta(days=30)).isoformat()
    past = (date.today() - timedelta(days=1)).isoformat()
    add_member(client, "Amine", future)
    add_member(client, "Lina", past)
    page = client.get("/app/members").get_data(as_text=True)
    assert "Amine" in page and "Lina" in page and "Actif" in page and "Expiré" in page

    amine, lina = sorted(member_ids(client))
    token = csrf_of(client, "/app")
    # Expired member cannot enter
    r = client.post(f"/members/{lina}/entry", data={"csrf": token})
    assert r.status_code == 409
    # Active member can
    r = client.post(f"/members/{amine}/entry", data={"csrf": token}, follow_redirects=True)
    assert "Passage enregistré pour Amine" in r.get_data(as_text=True)
    assert "Manuel" in client.get("/app/access").get_data(as_text=True)
    # Renewal fixes expired member
    r = client.post(f"/members/{lina}/renew", data={"csrf": token, "subscription_end": future})
    assert r.status_code == 302
    r = client.post(f"/members/{lina}/entry", data={"csrf": token})
    assert r.status_code == 302
    # Invalid date rejected
    assert client.post(f"/members/{lina}/renew", data={"csrf": token, "subscription_end": "31/12/2030"}).status_code == 400
    # Delete removes member and its entries
    client.post(f"/members/{amine}/delete", data={"csrf": token})
    assert amine not in member_ids(client)
    overview = client.get("/app").get_data(as_text=True)
    assert "Amine" not in overview


def test_tenant_isolation(app):
    c1, c2 = app.test_client(), app.test_client()
    signup(c1, "gym@a.dz", company="Gym A", sector="fitness")
    signup(c2, "school@b.dz", company="École B", sector="canteen")
    add_member(c1, "Membre Gym")
    add_member(c2, "Élève École")
    (gym_id,) = member_ids(c1)
    (school_id,) = member_ids(c2)

    assert "Membre Gym" not in c2.get("/app/members").get_data(as_text=True)
    assert "Élève École" not in c1.get("/app/members").get_data(as_text=True)
    assert "sector-canteen" in c2.get("/app").get_data(as_text=True)

    token2 = csrf_of(c2, "/app")
    # Tenant 2 cannot touch tenant 1 member by id
    assert c2.post(f"/members/{gym_id}/renew", data={"csrf": token2, "subscription_end": "2031-01-01"}).status_code == 404
    assert c2.post(f"/members/{gym_id}/delete", data={"csrf": token2}).status_code == 404
    assert c2.post(f"/members/{gym_id}/entry", data={"csrf": token2}).status_code == 404
    assert c2.post(f"/members/{gym_id}/consent/revoke", data={"csrf": token2}).status_code == 404
    assert c2.post(f"/api/members/{gym_id}/enroll", json={"consent": True, "image": ""}, headers={"X-CSRF-Token": token2}).status_code == 404
    assert gym_id in member_ids(c1)


def test_settings_change_sector(client):
    signup(client, "a@b.c", sector="fitness")
    token = csrf_of(client, "/app")
    r = client.post("/settings", data={"csrf": token, "company": "Cowork Alger", "sector": "coworking"}, follow_redirects=True)
    page = r.get_data(as_text=True)
    assert "Cowork Alger" in page and "sector-coworking" in page
    assert client.post("/settings", data={"csrf": token, "company": "X", "sector": "inconnu"}).status_code == 400


def test_face_api_requires_consent_and_handles_missing_engine(client):
    signup(client, "a@b.c")
    add_member(client, "Sara")
    (sid,) = member_ids(client)
    token = csrf_of(client, "/app")
    r = client.post(f"/api/members/{sid}/enroll", json={"consent": False, "image": "x"}, headers={"X-CSRF-Token": token})
    assert r.status_code == 400 and "Consentement" in r.get_json()["message"]
    r = client.post("/api/recognize", json={"image": "x"}, headers={"X-CSRF-Token": token})
    # Either engine missing (503) or invalid image (400): never a crash, always JSON
    assert r.status_code in (400, 503) and "message" in r.get_json()


def test_security_headers(client):
    r = client.get("/")
    assert "default-src 'self'" in r.headers["Content-Security-Policy"]
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    signup(client, "a@b.c")
    assert client.get("/app").headers["Cache-Control"] == "no-store"


def test_duplicate_manual_entry_suppressed(client):
    signup(client, "a@b.c")
    add_member(client, "Yacine", (date.today() + timedelta(days=10)).isoformat())
    (mid,) = member_ids(client)
    token = csrf_of(client, "/app")
    first = client.post(f"/members/{mid}/entry", data={"csrf": token}, follow_redirects=True).get_data(as_text=True)
    second = client.post(f"/members/{mid}/entry", data={"csrf": token}, follow_redirects=True).get_data(as_text=True)
    assert "Passage enregistré pour Yacine" in first and "déjà enregistré(e) il y a moins d'une minute" in second
    assert second.count("Autorisé</span>") == 1  # journal shows a single granted row
    assert ">1<" in client.get("/app").get_data(as_text=True)  # "Passages aujourd'hui" = 1


def test_api_json_statuses_without_face(client):
    signup(client, "a@b.c")
    token = csrf_of(client, "/app")
    r = client.post("/api/recognize", json={"image": "nope"}, headers={"X-CSRF-Token": token})
    assert r.status_code in (400, 503) and r.get_json()["status"] == "error"
    r = client.post("/api/recognize", json={}, headers={"X-CSRF-Token": "bad"})
    assert r.status_code == 400 and "message" in r.get_json()


@pytest.mark.skipif(not __import__("os").environ.get("FACE_TEST_IMAGE"), reason="set FACE_TEST_IMAGE=/path/photo.jpg to run the real face engine")
def test_real_face_enroll_and_recognize(client):
    import base64
    pytest.importorskip("face_recognition")
    photo = __import__("os").environ["FACE_TEST_IMAGE"]
    data = "data:image/jpeg;base64," + base64.b64encode(open(photo, "rb").read()).decode()
    signup(client, "a@b.c")
    add_member(client, "Personne Test", (date.today() + timedelta(days=10)).isoformat())
    (mid,) = member_ids(client)
    token = csrf_of(client, "/app")
    r = client.post(f"/api/members/{mid}/enroll", json={"consent": True, "image": data}, headers={"X-CSRF-Token": token})
    assert r.status_code == 200, r.get_json()
    r = client.post("/api/recognize", json={"image": data}, headers={"X-CSRF-Token": token})
    assert r.status_code == 200 and r.get_json()["status"] == "granted" and r.get_json()["name"] == "Personne Test"
    # Expired subscription: recognized but refused, and logged as refused
    client.post(f"/members/{mid}/renew", data={"csrf": token, "subscription_end": (date.today() - timedelta(days=1)).isoformat()})
    r = client.post("/api/recognize", json={"image": data}, headers={"X-CSRF-Token": token})
    assert r.status_code == 403 and r.get_json()["status"] == "expired"
    page = client.get("/app/access").get_data(as_text=True)
    assert "Refusé</span>" in page and "Autorisé</span>" in page


def test_blank_image_reports_no_face_with_reason(client):
    import base64, io
    from PIL import Image
    pytest.importorskip("face_recognition")
    signup(client, "a@b.c")
    token = csrf_of(client, "/app")
    buf = io.BytesIO()
    Image.new("RGB", (640, 480), (200, 200, 200)).save(buf, "JPEG")
    data = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    r = client.post("/api/recognize", json={"image": data}, headers={"X-CSRF-Token": token})
    assert r.status_code == 422 and r.get_json() == {"status": "no_face", "reason": "none", "message": "Aucun visage détecté. Placez-vous face à la caméra."}


def test_voice_clips_served(client):
    for name in ("granted", "expired", "unknown", "far", "none", "multi", "camera_on", "camera_denied", "auto_on", "enrolled"):
        r = client.get(f"/static/voice/{name}.mp3")
        assert r.status_code == 200 and r.mimetype == "audio/mpeg", name
    assert 'data-voice-base="/static/voice/"' in client.get("/").get_data(as_text=True)


def test_sector_vocabulary_and_legacy_mapping(client, app):
    signup(client, "a@b.c", sector="office")
    page = client.get("/app/members").get_data(as_text=True)
    assert "Ajouter un employé" in page and "Contrat jusqu'au" in page and "sector-office" in page
    # Legacy sectors from earlier databases are remapped at startup
    import sqlite3
    conn = sqlite3.connect(app.config["DATABASE"])
    conn.execute("UPDATE organizations SET sector='enterprise'")
    conn.commit(); conn.close()
    from web.app import create_app
    create_app({"DATABASE": app.config["DATABASE"], "SESSION_COOKIE_SECURE": False, "TESTING": True})
    conn = sqlite3.connect(app.config["DATABASE"])
    assert conn.execute("SELECT sector FROM organizations").fetchone()[0] == "office"
    conn.close()


def test_add_and_capture_flow_opens_dialog(client):
    signup(client, "a@b.c")
    token = csrf_of(client, "/app/members")
    r = client.post("/members", data={"csrf": token, "name": "Nadia", "subscription_end": "2031-01-01", "capture": "1"})
    assert r.status_code == 302 and "enroll=" in r.headers["Location"]
    page = client.get(r.headers["Location"]).get_data(as_text=True)
    (mid,) = member_ids(client)
    assert f'data-auto-open="{mid}"' in page and "Nadia" in page


def test_canteen_one_meal_per_day(client):
    signup(client, "a@b.c", sector="canteen")
    add_member(client, "Élève A", (date.today() + timedelta(days=200)).isoformat())
    (mid,) = member_ids(client)
    token = csrf_of(client, "/app")
    first = client.post(f"/members/{mid}/entry", data={"csrf": token}, follow_redirects=True).get_data(as_text=True)
    assert "Repas enregistré pour Élève A" in first
    # Simulate the 60 s duplicate window having passed: backdate the first entry
    import sqlite3
    conn = sqlite3.connect(client.application.config["DATABASE"])
    conn.execute("UPDATE entries SET created_at=?", ((datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(),))
    conn.commit(); conn.close()
    second = client.post(f"/members/{mid}/entry", data={"csrf": token}, follow_redirects=True).get_data(as_text=True)
    assert "déjà enregistré(e) aujourd'hui" in second and second.count("Autorisé</span>") == 1
    overview = client.get("/app").get_data(as_text=True)
    assert "Repas servis aujourd'hui" in overview


def test_office_late_detection_and_attendance(client):
    signup(client, "a@b.c", sector="office")
    token = csrf_of(client, "/app")
    # Work day starts at 00:00 with no tolerance: any arrival today is late
    client.post("/settings", data={"csrf": token, "company": "PME X", "sector": "office", "timezone": "Africa/Algiers", "work_start": "00:00", "late_tolerance": "0"})
    add_member(client, "Karim", "2031-01-01")
    add_member(client, "Sofia", "2031-01-01")
    karim, sofia = sorted(member_ids(client))
    r = client.post(f"/members/{karim}/entry", data={"csrf": token}, follow_redirects=True).get_data(as_text=True)
    assert "Pointage enregistré pour Karim" in r and "retard de" in r
    overview = client.get("/app").get_data(as_text=True)
    assert "Présences du jour" in overview and "En retard" in overview and "Absent</span>" in overview
    assert "Retards aujourd'hui" in overview and "Pointé</span>" in client.get("/app/access").get_data(as_text=True)
    # Start of day late in the evening: nobody is late anymore
    client.post("/settings", data={"csrf": token, "company": "PME X", "sector": "office", "timezone": "Africa/Algiers", "work_start": "23:59", "late_tolerance": "0"})
    conn = __import__("sqlite3").connect(client.application.config["DATABASE"])
    conn.execute("DELETE FROM entries"); conn.commit(); conn.close()
    r = client.post(f"/members/{sofia}/entry", data={"csrf": token}, follow_redirects=True).get_data(as_text=True)
    assert "Pointage enregistré pour Sofia" in r and "retard de" not in r
    # Settings validation
    assert client.post("/settings", data={"csrf": token, "company": "PME X", "sector": "office", "timezone": "Mars/Olympus", "work_start": "08:30", "late_tolerance": "5"}).status_code == 400
    assert client.post("/settings", data={"csrf": token, "company": "PME X", "sector": "office", "timezone": "UTC", "work_start": "25:99", "late_tolerance": "5"}).status_code == 400


def test_landing_shows_four_targets(client):
    page = client.get("/").get_data(as_text=True)
    for text in ("Salles de sport", "PME & bureaux", "Coworking", "Cantines", "buddy punching", "Cible principale"):
        assert text in page
    assert 'value="office" selected' in client.get("/signup?sector=office").get_data(as_text=True)


def test_upgrade_from_first_schema(tmp_path):
    """Databases created by the first web version (no status/local_date/timezone columns) must migrate."""
    import sqlite3
    path = str(tmp_path / "old.db")
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE organizations(id INTEGER PRIMARY KEY, name TEXT NOT NULL, sector TEXT NOT NULL);
        CREATE TABLE users(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
        CREATE TABLE members(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', subscription_end TEXT NOT NULL, encoding TEXT, consent_at TEXT, UNIQUE(org_id,id));
        CREATE TABLE entries(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, member_id INTEGER NOT NULL, actor_id INTEGER NOT NULL, created_at TEXT NOT NULL, method TEXT NOT NULL);
        INSERT INTO organizations VALUES(1,'Old Gym','leisure');
        INSERT INTO users VALUES(1,1,'old@x.y','pbkdf2:sha256:1$a$b');
        INSERT INTO members(id,org_id,name,subscription_end) VALUES(1,1,'Ancien','2031-01-01');
        INSERT INTO entries VALUES(1,1,1,1,'2026-10-03T07:30:00+00:00','Manuel');
    """)
    conn.commit(); conn.close()
    create_app({"DATABASE": path, "SESSION_COOKIE_SECURE": False, "TESTING": True})
    conn = sqlite3.connect(path)
    org = conn.execute("SELECT sector, timezone, work_start FROM organizations").fetchone()
    entry = conn.execute("SELECT status, local_date, local_time, late FROM entries").fetchone()
    conn.close()
    assert org == ("fitness", "Africa/Algiers", "08:30")
    assert entry == ("granted", "2026-10-03", "08:30", 0)  # 07:30 UTC = 08:30 in Algiers


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200 and r.get_json()["status"] == "ok" and isinstance(r.get_json()["face_engine"], bool)


def test_trust_proxy_rate_limits_per_cloudflare_client_ip(tmp_path):
    """Behind Cloudflare Tunnel every request comes from 127.0.0.1: limits must key on CF-Connecting-IP."""
    app = create_app({"DATABASE": str(tmp_path / "p.db"), "SESSION_COOKIE_SECURE": False, "TESTING": True, "TRUST_PROXY": True})
    client = app.test_client()
    token = csrf_of(client)
    for _ in range(10):
        client.post("/login", data={"csrf": token, "email": "x@y.z", "password": "bad"}, headers={"CF-Connecting-IP": "203.0.113.10"})
    blocked = client.post("/login", data={"csrf": token, "email": "x@y.z", "password": "bad"}, headers={"CF-Connecting-IP": "203.0.113.10"})
    other = client.post("/login", data={"csrf": token, "email": "x@y.z", "password": "bad"}, headers={"CF-Connecting-IP": "198.51.100.7"})
    assert blocked.status_code == 429 and other.status_code == 200


def test_database_dir_holds_session_key(tmp_path, monkeypatch):
    monkeypatch.setenv("WEB_DATABASE", str(tmp_path / "vol" / "web.db"))
    monkeypatch.delenv("SECRET_KEY", raising=False)
    first = create_app({"SESSION_COOKIE_SECURE": False, "TESTING": True})
    second = create_app({"SESSION_COOKIE_SECURE": False, "TESTING": True})
    assert (tmp_path / "vol" / "session.key").exists() and (tmp_path / "vol" / "web.db").exists()
    assert first.secret_key == second.secret_key  # stable across restarts, stored on the persistent volume
