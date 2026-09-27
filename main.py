import cv2
import face_recognition
import numpy as np
from datetime import datetime
from db import init_db, get_all_members

# --- Config ---
USE_ARDUINO = False          # Mettre True si un relais Arduino est branché
ARDUINO_PORT = "COM3"        # ou "/dev/ttyUSB0" sur Linux
TOLERANCE = 0.5

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

known_encodings = [m["encoding"] for m in members]
known_names = [m["name"] for m in members]
known_subs = [m["subscription_end"] for m in members]

video = cv2.VideoCapture(0)
print("[INFO] Caméra active. Appuyez sur 'q' pour quitter.")

while True:
    ret, frame = video.read()
    if not ret:
        break

    small = cv2.resize(frame, (0, 0), fx=0.25, fy=0.25)
    rgb_small = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)

    locations = face_recognition.face_locations(rgb_small)
    encodings = face_recognition.face_encodings(rgb_small, locations)

    for (top, right, bottom, left), face_encoding in zip(locations, encodings):
        top, right, bottom, left = top * 4, right * 4, bottom * 4, left * 4

        name, status, color = "Inconnu", "ACCES REFUSE", (0, 0, 255)

        if known_encodings:
            matches = face_recognition.compare_faces(known_encodings, face_encoding, tolerance=TOLERANCE)
            distances = face_recognition.face_distance(known_encodings, face_encoding)
            if True in matches:
                idx = int(np.argmin(distances))
                if matches[idx]:
                    name = known_names[idx]
                    if check_subscription(known_subs[idx]):
                        status, color = f"{name.upper()} - ACCES AUTORISE", (0, 255, 0)
                        open_access()
                    else:
                        status, color = f"{name.upper()} - ABONNEMENT EXPIRE", (0, 165, 255)

        cv2.rectangle(frame, (left, top), (right, bottom), color, 2)
        cv2.rectangle(frame, (left, bottom - 35), (right, bottom), color, cv2.FILLED)
        cv2.putText(frame, status, (left + 6, bottom - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)

    cv2.imshow("Face ID - Controle d'acces", frame)
    if cv2.waitKey(1) & 0xFF == ord("q"):
        break

video.release()
cv2.destroyAllWindows()
