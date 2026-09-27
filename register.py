import cv2
import face_recognition
import os
from datetime import datetime
from db import init_db, add_member, get_base_dir

PHOTOS_DIR = os.path.join(get_base_dir(), "photos")
os.makedirs(PHOTOS_DIR, exist_ok=True)

init_db()

name = input("Nom du membre : ").strip()
sub_end = input("Date de fin d'abonnement (AAAA-MM-JJ) : ").strip()
datetime.strptime(sub_end, "%Y-%m-%d")  # validation du format

# Consentement automatique : se presenter volontairement devant la camera
# pour se faire enregistrer vaut acceptation du stockage de son visage
# (voir docs/conformite_donnees.md pour le detail).
print("\n[INFO] Se presenter devant la camera pour la capture vaut consentement a l'enregistrement du visage.")

cam = cv2.VideoCapture(0)
print("[INFO] Placez-vous face à la caméra. Appuyez sur ESPACE pour capturer, ECHAP pour annuler.")

encoding = None
while True:
    ret, frame = cam.read()
    if not ret:
        break
    cv2.imshow("Enregistrement - ESPACE pour capturer", frame)
    key = cv2.waitKey(1) & 0xFF

    if key == 27:  # ECHAP
        break

    if key == 32:  # ESPACE
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        encs = face_recognition.face_encodings(rgb)
        if len(encs) == 0:
            print("[ERREUR] Aucun visage détecté, réessayez.")
            continue
        encoding = encs[0]
        photo_path = os.path.join(PHOTOS_DIR, f"{name}.jpg")
        cv2.imwrite(photo_path, frame)
        break

cam.release()
cv2.destroyAllWindows()

if encoding is not None:
    add_member(name, encoding, sub_end, photo_path, consent=True)
    print(f"[OK] {name} enregistré avec abonnement jusqu'au {sub_end}.")
else:
    print("[ANNULE] Aucun membre enregistré.")
