import cv2
import face_recognition
import numpy as np
from datetime import datetime
from db import init_db, get_all_members, log_access
from liveness import LivenessTracker, compute_ear_from_landmarks

# --- Config ---
USE_ARDUINO = False          # Mettre True si un relais Arduino est branché
ARDUINO_PORT = "COM3"        # ou "/dev/ttyUSB0" sur Linux
TOLERANCE = 0.5
REQUIRE_BLINK = True         # Anti-spoofing : exige un clignement des yeux avant d'ouvrir l'accès

# --- Performance ---
RESIZE_FACTOR = 0.25         # facteur de sous-echantillonnage pour la detection/l'encodage
DETECT_EVERY_N_FRAMES = 2    # ne relance la detection+reconnaissance complete qu'1 frame sur N
                              # (entre deux, on reaffiche les dernieres boites connues -> fluide et 2x moins de CPU)

arduino = None
if USE_ARDUINO:
    import serial
    arduino = serial.Serial(ARDUINO_PORT, 9600)


def check_subscription(date_str):
    return datetime.now() <= datetime.strptime(date_str, "%Y-%m-%d")


def open_access():
    if arduino:
        arduino.write(b"OPEN\n")


init_db()
members = get_all_members()
if not members:
    print("[ATTENTION] Aucun membre enregistré. Lancez register.py d'abord.")

known_ids = [m["id"] for m in members]
known_encodings = [m["encoding"] for m in members]
known_names = [m["name"] for m in members]
known_subs = [m["subscription_end"] for m in members]

liveness_tracker = LivenessTracker()
inv_resize = 1.0 / RESIZE_FACTOR

video = cv2.VideoCapture(0)
# Demande explicitement un flux plus leger a la camera quand elle le permet
# (evite de decoder/traiter une image 1080p si on n'en a pas besoin).
video.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
video.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

print("[INFO] Caméra active. Appuyez sur 'q' pour quitter.")

frame_count = 0
detections = []  # boites+statuts reutilises entre deux passes de detection
last_logged_status = {}  # nom -> dernier statut journalise (evite de spammer l'historique)

while True:
    ret, frame = video.read()
    if not ret:
        break

    frame_count += 1
    run_detection = (frame_count % DETECT_EVERY_N_FRAMES == 0) or not detections

    if run_detection:
        small = cv2.resize(frame, (0, 0), fx=RESIZE_FACTOR, fy=RESIZE_FACTOR)
        rgb_small = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)

        locations = face_recognition.face_locations(rgb_small, model="hog")
        encodings = face_recognition.face_encodings(rgb_small, locations)

        detections = []
        for (top, right, bottom, left), face_encoding in zip(locations, encodings):
            top, right, bottom, left = (int(top * inv_resize), int(right * inv_resize),
                                         int(bottom * inv_resize), int(left * inv_resize))

            name, status, color = "Inconnu", "ACCES REFUSE", (0, 0, 255)

            if known_encodings:
                matches = face_recognition.compare_faces(known_encodings, face_encoding, tolerance=TOLERANCE)
                distances = face_recognition.face_distance(known_encodings, face_encoding)
                if True in matches:
                    idx = int(np.argmin(distances))
                    if matches[idx]:
                        name = known_names[idx]
                        if check_subscription(known_subs[idx]):
                            if REQUIRE_BLINK:
                                member_id = known_ids[idx]
                                if liveness_tracker.is_verified(member_id):
                                    # Deja verifie recemment : on evite de refaire le
                                    # calcul EAR (crop + conversion + landmarks dlib),
                                    # on se contente de rafraichir la presence.
                                    liveness_tracker.update(member_id, None)
                                    verified, remaining = True, 0.0
                                else:
                                    ear = compute_ear_from_landmarks(frame, (top, right, bottom, left))
                                    verified, remaining = liveness_tracker.update(member_id, ear)
                                if verified:
                                    status, color = f"{name.upper()} - ACCES AUTORISE", (0, 255, 0)
                                    open_access()
                                else:
                                    status = f"{name.upper()} - CLIGNEZ DES YEUX ({int(remaining) + 1}s)"
                                    color = (255, 190, 0)
                            else:
                                status, color = f"{name.upper()} - ACCES AUTORISE", (0, 255, 0)
                                open_access()
                        else:
                            status, color = f"{name.upper()} - ABONNEMENT EXPIRE", (0, 165, 255)
                            if REQUIRE_BLINK:
                                liveness_tracker.reset(known_ids[idx])

            detections.append(((top, right, bottom, left), name, status, color))

            # Historique des acces : on ne journalise que lorsque le statut
            # change pour cette identite (pas a chaque frame de detection).
            if last_logged_status.get(name) != status:
                last_logged_status[name] = status
                log_access(name, status)

        if REQUIRE_BLINK:
            liveness_tracker.cleanup()

    for (top, right, bottom, left), name, status, color in detections:
        cv2.rectangle(frame, (left, top), (right, bottom), color, 2)
        cv2.rectangle(frame, (left, bottom - 35), (right, bottom), color, cv2.FILLED)
        cv2.putText(frame, status, (left + 6, bottom - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)

    cv2.imshow("Face ID - Controle d'acces", frame)
    if cv2.waitKey(1) & 0xFF == ord("q"):
        break

video.release()
cv2.destroyAllWindows()
