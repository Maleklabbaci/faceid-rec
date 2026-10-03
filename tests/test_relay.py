"""Tests du relais de kiosque (tools/kiosk-relay.py).

Le boîtier sur site est le maillon qui touche à la fois au jeton d'appareil et à la porte :
ces tests vérifient ce qui doit l'être sans caméra ni OpenCV — les droits du fichier de jeton,
l'en-tête d'authentification réellement envoyé, et la façon dont une réponse du serveur se
traduit en message compréhensible pour la personne qui installe.
"""

import importlib.util
import json
import os
import stat
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("kiosk_relay", ROOT / "tools" / "kiosk-relay.py")
relay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(relay)


class Stub(BaseHTTPRequestHandler):
    """Un faux FaceID : enough to drive the relay's HTTP layer."""

    responses = {}   # path → (status, payload)
    seen = []        # every request received: (method, path, headers, body)

    def _handle(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8") if length else ""
        Stub.seen.append((self.command, self.path, dict(self.headers), body))
        status, payload = Stub.responses.get(self.path, (404, {"message": "route inconnue"}))
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    do_GET = do_POST = _handle

    def log_message(self, *_args):
        pass


@pytest.fixture
def server():
    Stub.responses = {}
    Stub.seen = []
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    thread.join(timeout=5)


def test_token_file_is_only_readable_by_its_owner(tmp_path):
    path = tmp_path / "jeton"
    relay.save_token(str(path), "abcd-1234")
    mode = stat.S_IMODE(os.stat(path).st_mode)
    assert mode == 0o600, "le jeton donne un kiosque : il ne doit pas être lisible par les autres comptes"
    assert path.read_text().strip() == "abcd-1234"


def test_token_resolution_prefers_the_obvious(tmp_path):
    path = tmp_path / "jeton"
    relay.save_token(str(path), "du-fichier")

    class Args:
        token = ""
        token_file = str(path)

    assert relay.read_token(Args) == "du-fichier"
    Args.token = "en-ligne-de-commande"
    assert relay.read_token(Args) == "en-ligne-de-commande"
    Args.token = ""
    os.environ["FACEID_TOKEN"] = "de-lenvironnement"
    try:
        assert relay.read_token(Args) == "de-lenvironnement"
    finally:
        del os.environ["FACEID_TOKEN"]


def test_pair_sends_the_code_as_json_and_keeps_the_token(server, tmp_path):
    Stub.responses["/api/pair"] = (200, {
        "ok": True, "token": "jeton-du-boitier",
        "device": {"id": 3, "name": "Caméra entrée", "kind": "box"},
        "org": {"name": "Salle Olympia", "sector": "fitness"},
        "message": "Caméra entrée est relié à Salle Olympia.",
    })
    token = relay.pair(server, "ab k7 qd", str(tmp_path / "jeton"))
    assert token == "jeton-du-boitier"
    method, path, headers, body = Stub.seen[-1]
    assert (method, path) == ("POST", "/api/pair")
    assert json.loads(body) == {"code": "ABK7QD"}, "le code est normalisé avant l'envoi, comme dans le navigateur"
    assert headers["Content-Type"].startswith("application/json")
    assert (tmp_path / "jeton").read_text().strip() == "jeton-du-boitier"


def test_a_short_code_is_refused_before_calling(server, tmp_path, capsys):
    with pytest.raises(SystemExit) as exit_info:
        relay.pair(server, "ab c", str(tmp_path / "jeton"))
    assert exit_info.value.code == 2
    assert "6 caractères" in capsys.readouterr().out
    assert Stub.seen == [], "pas d'appel réseau pour une faute de frappe"


def test_pair_failure_is_explained_and_exits_cleanly(server, tmp_path):
    Stub.responses["/api/pair"] = (410, {"message": "Ce code a expiré. Redemandez-en un dans l'espace de l'entreprise."})
    with pytest.raises(SystemExit) as exit_info:
        relay.pair(server, "ZZZZZZ", str(tmp_path / "jeton"))
    assert exit_info.value.code == 3, "un code mort est le cas le plus fréquent : code de sortie dédié"
    assert not (tmp_path / "jeton").exists(), "rien n'est écrit quand l'appairage échoue"


def test_calls_carry_the_bearer_token(server):
    Stub.responses["/api/device/state"] = (200, {"ok": True, "device": {"name": "x"}, "org": {"name": "y"}})
    status, data = relay.call(server, "/api/device/state", "mon-jeton")
    assert status == 200 and data["ok"] is True
    assert Stub.seen[-1][2]["Authorization"] == "Bearer mon-jeton"
    assert Stub.seen[-1][0] == "GET", "un GET ne porte pas de corps"


def test_camera_credentials_use_basic_auth(server):
    Stub.responses["/snapshot.jpg"] = (200, {"ok": True})
    relay.call(server, "/snapshot.jpg", "", None, "cam", "secret")
    assert Stub.seen[-1][2]["Authorization"].startswith("Basic ")
    import base64
    assert base64.b64decode(Stub.seen[-1][2]["Authorization"][6:]).decode() == "cam:secret"


def test_revoked_token_says_so_in_french(server, capsys):
    Stub.responses["/api/device/descriptors"] = (401, {"message": "Appareil non relié."})
    with pytest.raises(SystemExit) as exit_info:
        relay.known_faces(server, "jeton-revoque")
    assert exit_info.value.code == 4, "jeton mort : code de sortie dédié, pour un service systemd qui redémarre mal"
    printed = capsys.readouterr().out
    assert "révoqué" in printed and "--code" in printed, "la personne devant l'écran doit savoir quoi faire"


def test_recognized_is_posted_with_the_measured_distance(server):
    Stub.responses["/api/device/recognized"] = (200, {"status": "granted", "message": "Nadia : accès autorisé."})
    status, data = relay.report(server, "jeton", 12, 0.3123456)
    assert status == 200 and data["status"] == "granted"
    assert json.loads(Stub.seen[-1][3]) == {"member_id": 12, "distance": 0.312}, "la distance voyage, l'interprétation reste côté serveur"


def test_network_failure_does_not_raise_a_traceback(server):
    status, data = relay.call("http://127.0.0.1:1", "/api/device/state", "x")   # nothing listens there
    assert status == 0 and data.get("message")
    assert isinstance(data["message"], str)
