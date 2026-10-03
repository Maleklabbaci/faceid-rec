import re
from datetime import date, timedelta

import pytest

from web.app import create_app


@pytest.fixture
def app(tmp_path):
    return create_app({"DATABASE": str(tmp_path / "test.db"), "SESSION_COOKIE_SECURE": False, "TESTING": True})


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
    assert "Entrée enregistrée" in r.get_data(as_text=True)
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
    signup(c2, "school@b.dz", company="École B", sector="education")
    add_member(c1, "Membre Gym")
    add_member(c2, "Élève École")
    (gym_id,) = member_ids(c1)
    (school_id,) = member_ids(c2)

    assert "Membre Gym" not in c2.get("/app/members").get_data(as_text=True)
    assert "Élève École" not in c1.get("/app/members").get_data(as_text=True)
    assert "sector-education" in c2.get("/app").get_data(as_text=True)

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
    assert "Entrée enregistrée" in first and "déjà enregistrée" in second
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
