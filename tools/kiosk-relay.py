#!/usr/bin/env python3
"""Relais de kiosque pour caméra réseau ou boîtier sans navigateur.

Pourquoi ce script : une page web ne sait pas lire un flux RTSP, et une caméra IP
refuse les requêtes venues d'un autre site (CORS). Le relais tourne donc sur place
— Raspberry Pi, mini-PC, NAS — détecte les visages, les compare aux empreintes
descendues de l'API, et journalise le passage. Lui seul peut actionner la porte.

    # 1. relier le boîtier (code à usage unique, onglet « Appareils reliés »)
    python3 tools/kiosk-relay.py --base https://monsite.pages.dev --code ABK7QD

    # 2. le faire tourner sur une webcam USB
    python3 tools/kiosk-relay.py --source usb --interval 0.4

    # 3. ou sur une caméra IP : instantané HTTP (toutes les caméras) ou flux
    python3 tools/kiosk-relay.py --source http://192.168.1.44/snapshot.jpg --user cam --pass secret
    python3 tools/kiosk-relay.py --source rtsp://cam:secret@192.168.1.44:554/Streaming/Channels/101

    # 4. ouvrir la gâche quand l'API autorise le passage
    python3 tools/kiosk-relay.py --on-granted "curl -s http://192.168.1.50/relay?open=1"

Le jeton reçu à l'appairage est gardé dans ~/.faceid-device (droits 600) et lu à
chaque démarrage. La décision d'ouvrir ou non n'est jamais prise ici : c'est le
serveur qui connaît l'abonnement, la règle du secteur et le doublon du jour.
"""

import argparse
import base64
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

TOLERANCE = 0.5          # même seuil que l'application de bureau et que le kiosque web
USER_AGENT = "faceid-kiosk-relay/1.0"


def log(message):
    print(time.strftime("[%H:%M:%S] ") + message, flush=True)


def die(message, code=1):
    log("ERREUR : " + message)
    sys.exit(code)


# --------------------------------------------------------------------------- jeton
def token_path(value):
    return os.path.expanduser(value)


def read_token(args):
    if args.token:
        return args.token.strip()
    env_token = os.environ.get("FACEID_TOKEN")
    if env_token:
        return env_token.strip()
    path = token_path(args.token_file)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read().strip()
    return ""


def save_token(path, token):
    path = token_path(path)
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    handle = os.open(path, flags, 0o600)     # le jeton donne un accès : jamais lisible par les autres
    try:
        os.write(handle, (token + "\n").encode("utf-8"))
    finally:
        os.close(handle)
    os.chmod(path, 0o600)


# --------------------------------------------------------------------------- API
def call(base, path, token="", payload=None, user="", password="", timeout=15):
    """Un appel JSON à l'API du site. Pas de cookie : l'authentification est le jeton."""
    url = base.rstrip("/") + path
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    request.add_header("User-Agent", USER_AGENT)
    if data:
        request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", "Bearer " + token)
    if user:
        basic = base64.b64encode(("%s:%s" % (user, password or "")).encode("utf-8")).decode("ascii")
        request.add_header("Authorization", "Basic " + basic)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
            return response.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", "replace")
        try:
            return err.code, json.loads(raw)
        except ValueError:
            return err.code, {"message": raw[:200] or err.reason}
    except urllib.error.URLError as err:
        return 0, {"message": str(err.reason)}


def normalize_code(value):
    """Le code est recopié depuis un écran ou une fiche imprimée : casse et espaces ne comptent pas."""
    return "".join(ch for ch in str(value or "").upper() if ch.isalnum())[:8]


def pair(base, code, token_file, user="", password=""):
    code = normalize_code(code)
    if len(code) != 6:
        die("un code d'appairage compte 6 caractères (lettres et chiffres) — « %s » ne convient pas." % code, 2)
    status, data = call(base, "/api/pair", "", {"code": code}, user, password)
    if status != 200:
        die("appairage refusé (%s) : %s" % (status or "réseau", data.get("message", "sans réponse")), 3)
    save_token(token_file, data["token"])
    log("appareil relié : %s — %s" % (data["device"]["name"], data.get("message", "")))
    log("jeton écrit dans %s (le montrer à quelqu'un = lui donner un kiosque)" % token_path(token_file))
    return data["token"]


def known_faces(base, token, user="", password=""):
    status, data = call(base, "/api/device/descriptors", token, None, user, password)
    if status == 401:
        die("jeton refusé : l'appareil a été révoqué ou a expiré. Relancez avec --code <nouveau code>.", 4)
    if status != 200:
        die("liste des visages indisponible (%s) : %s" % (status or "réseau", data.get("message", "")), 4)
    members = []
    for person in data.get("members", []):
        try:
            import numpy as np
            vector = np.array(person["d"], dtype="float64")
        except Exception:                                    # numpy manque : on compare en pur Python
            vector = person["d"]
        members.append({"id": person["id"], "name": person["name"], "encoding": vector})
    return members


def report(base, token, member_id, distance, user="", password=""):
    status, data = call(base, "/api/device/recognized", token,
                        {"member_id": member_id, "distance": round(distance, 3)}, user, password)
    return status, data


# --------------------------------------------------------------------------- images
def open_source(source, user="", password=""):
    """Retourne (capture, snapshot_url) : l'un des deux est utilisable, jamais les deux."""
    if source in ("", "usb"):
        import cv2
        camera = cv2.VideoCapture(0)
        if not camera.isOpened():
            die("aucune webcam sur /dev/video0 (ou VideoCapture(0)).")
        return camera, None
    if source.startswith("rtsp://") or source.startswith("rtmp://") or source.startswith("rtspt://"):
        import cv2
        camera = cv2.VideoCapture(source)
        if not camera.isOpened():
            die("flux %s injoignable : vérifiez l'adresse, le port et que cette caméra accepte "
                "un client ONVIF/RTSP. En cas de refus, utilisez l'URL d'instantané (--snapshot)." % source)
        return camera, None
    if source.startswith("http://") or source.startswith("https://"):
        if source.rstrip("/").endswith((".mjpeg", ".mjpg")) or "mjpeg" in source or "videostream" in source:
            import cv2
            camera = cv2.VideoCapture(source)
            if camera.isOpened():
                return camera, None
            camera.release()
        return None, source     # instantané à aller chercher à intervalle régulier
    # un fichier : utile pour essayer le relais sans caméra
    import cv2
    camera = cv2.VideoCapture(source)
    return (camera if camera.isOpened() else None), None


def read_frame(cv2, camera, snapshot_url, user, password, timeout):
    if camera is not None:
        ok, frame = camera.read()
        return frame if ok else None
    request = urllib.request.Request(snapshot_url, headers={"User-Agent": USER_AGENT})
    if user:
        basic = base64.b64encode(("%s:%s" % (user, password or "")).encode("utf-8")).decode("ascii")
        request.add_header("Authorization", "Basic " + basic)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as err:
        if err.code not in (401, 403):
            log("instantané refusé (%s) : %s" % (err.code, err.reason))
        return None
    except Exception as err:                                  # réseau, délai, caméra endormie
        log("instantané indisponible : %s" % err)
        return None
    import numpy as np
    return cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)


def faces(rgb, upsample=1):
    import face_recognition
    locations = face_recognition.face_locations(rgb, number_of_times_to_upsample=upsample)
    encodings = face_recognition.face_encodings(rgb, locations)
    return list(zip(locations, encodings))


def best_match(encoding, members):
    import numpy as np
    if not members:
        return None, 1.0
    vector = np.array(encoding, dtype="float64")
    best, distance = None, 10.0
    for member in members:
        d = float(np.linalg.norm(np.array(member["encoding"], dtype="float64") - vector))
        if d < distance:
            best, distance = member, d
    return (best, distance) if distance <= TOLERANCE else (None, distance)


# --------------------------------------------------------------------------- boucle
def main():
    parser = argparse.ArgumentParser(description="Relais kiosque FaceID pour caméra réseau ou boîtier sur site.")
    parser.add_argument("--base", default=os.environ.get("FACEID_BASE", "http://127.0.0.1:8788"),
                        help="adresse du site (défaut : %(default)s, ou FACEID_BASE)")
    parser.add_argument("--code", default="", help="code d'appairage à usage unique, affiché dans l'espace de l'entreprise")
    parser.add_argument("--token", default="", help="jeton de l'appareil, sinon FACEID_TOKEN, sinon le fichier de jeton")
    parser.add_argument("--token-file", default="~/.faceid-device", help="où lire/écrire le jeton (défaut : %(default)s)")
    parser.add_argument("--source", default="usb", help="« usb », une URL d'instantané http(s), ou un flux rtsp://")
    parser.add_argument("--snapshot", default="", help="URL d'instantané à tourner quand --source est une caméra HTTP capricieuse")
    parser.add_argument("--user", default="", help="identifiant de la caméra (authentification Basic)")
    parser.add_argument("--password", default="", help="mot de passe de la caméra")
    parser.add_argument("--interval", type=float, default=0.5, help="secondes entre deux analyses (défaut : %(default)s)")
    parser.add_argument("--cooldown", type=float, default=6.0, help="délai avant de renvoyer la même personne (défaut : %(default)s s)")
    parser.add_argument("--refresh", type=float, default=300.0, help="secondes entre deux téléchargements des empreintes")
    parser.add_argument("--on-granted", default="", help="commande à lancer quand l'API autorise le passage (la porte)")
    parser.add_argument("--once", action="store_true", help="analyse une image puis s'arrête (test)")
    args = parser.parse_args()

    try:
        import cv2  # noqa: F401  (vérifie la présence des dépendances avant de discuter avec le serveur)
    except ImportError:
        die("opencv-python est requis sur ce boîtier : pip install -r requirements.txt")
    try:
        import face_recognition  # noqa: F401
    except ImportError:
        die("face_recognition est requis sur ce boîtier : pip install -r requirements.txt")

    token = pair(args.base, args.code, args.token_file, args.user, args.password) if args.code else read_token(args)
    if not token:
        die("aucun jeton : passez --code <code d'appairage>, --token, ou FACEID_TOKEN.", 2)

    status, state = call(args.base, "/api/device/state", token, None, args.user, args.password)
    if status != 200:
        die("ce jeton ne vaut rien ici (%s) : %s" % (status or "réseau", state.get("message", "")), 4)
    device = state["device"]
    org = state["org"]
    log("kiosque « %s » pour %s (secteur %s) — %d passage(s) déjà journalisé(s) aujourd'hui"
        % (device["name"], org["name"], org["sector"], state.get("granted", 0)))

    members = []
    camera, snapshot = open_source(args.source, args.user, args.password)
    if args.snapshot:
        camera, snapshot = None, args.snapshot
    if camera is None and not snapshot:
        die("aucune source d'image utilisable (%s)." % args.source, 2)

    stop = {"requested": False}

    def handle_signal(_signum, _frame):
        stop["requested"] = True
        log("arrêt demandé…")

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    last_seen = {}
    next_refresh = 0.0
    idle_logged = False
    while not stop["requested"]:
        now = time.time()
        if now >= next_refresh:
            members = known_faces(args.base, token, args.user, args.password)
            next_refresh = now + args.refresh
            if not idle_logged and not members:
                log("aucun visage enregistré dans cet espace : rien à reconnaître pour l'instant.")
                idle_logged = True
            if members:
                log("%d empreinte(s) chargée(s)." % len(members))

        frame = read_frame(cv2, camera, snapshot, args.user, args.password, 20)
        if frame is None:
            time.sleep(max(0.2, args.interval))
            continue
        small = cv2.resize(frame, (0, 0), fx=0.5, fy=0.5)
        rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
        found = faces(rgb)
        if not found:
            if args.once:
                log("aucun visage sur cette image.")
                break
            time.sleep(max(0.05, args.interval / 4))
            continue

        for (top, right, bottom, left), encoding in found:
            member, distance = best_match(encoding, members)
            if member is None:
                log("visage inconnu (distance %.2f) — rien n'est journalisé." % distance)
                continue
            if time.time() - last_seen.get(member["id"], 0) < args.cooldown:
                continue
            last_seen[member["id"]] = time.time()
            status, data = report(args.base, token, member["id"], distance, args.user, args.password)
            message = data.get("message") or ("autorisé" if status == 200 else "refusé (%s)" % status)
            log("%s → %s" % (member["name"], message))
            if status == 200 and args.on_granted:
                log("commande d'ouverture : %s" % args.on_granted)
                try:
                    subprocess.run(args.on_granted, shell=True, check=False, timeout=20)
                except Exception as err:
                    log("ouverture impossible : %s" % err)
        if args.once:
            break
        if snapshot and args.interval:
            time.sleep(args.interval)
        time.sleep(0.02)

    if camera is not None:
        camera.release()
    log("relais arrêté.")


if __name__ == "__main__":
    main()
