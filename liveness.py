"""Anti-spoofing simple par detection de clignement des yeux (liveness check).

Objectif : empecher qu'une simple photo (imprimee ou affichee sur un ecran)
suffise a declencher l'ouverture d'acces. Avant d'accorder l'acces a une
personne reconnue, on exige qu'elle cligne des yeux au moins une fois dans
une fenetre de temps donnee.

Ce module reutilise uniquement `face_recognition`/`dlib` (deja une
dependance du projet) via les 68 points de repere du visage : pas besoin
d'ajouter MediaPipe ou une autre librairie.

Principe (Eye Aspect Ratio, EAR) :
    Pour chaque oeil, `face_recognition.face_landmarks` retourne 6 points.
    Le ratio EAR = (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||) chute nettement
    quand la paupiere se ferme. On detecte un clignement quand l'EAR passe
    sous un seuil pendant quelques frames consecutives puis remonte.

Utilisation typique (voir main.py / app.py) :

    tracker = LivenessTracker()
    ...
    ear = compute_ear_from_landmarks(rgb_frame, face_box)
    verified, remaining = tracker.update(member_id, ear)
    if verified:
        # accorder l'acces
    else:
        # afficher "Clignez des yeux pour verifier (Xs)"
"""

import time
import cv2
import face_recognition

EAR_THRESHOLD = 0.21       # sous ce seuil, l'oeil est considere ferme
EAR_CONSEC_FRAMES = 2      # nb de frames consecutives fermees pour valider un clignement
BLINK_TIMEOUT = 8.0        # secondes laissees pour cligner avant de relancer une fenetre
RESET_AFTER = 2.0          # si le visage disparait plus longtemps, on oublie l'etat (redemande un clignement)


def _dist(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


def eye_aspect_ratio(eye_points):
    """Calcule l'EAR a partir des 6 points d'un oeil (convention dlib 68-points)."""
    if len(eye_points) < 6:
        return None
    a = _dist(eye_points[1], eye_points[5])
    b = _dist(eye_points[2], eye_points[4])
    c = _dist(eye_points[0], eye_points[3])
    if c == 0:
        return None
    return (a + b) / (2.0 * c)


def compute_ear_from_landmarks(frame_bgr, face_box, margin=20):
    """Detecte les landmarks des yeux pour `face_box` (top, right, bottom,
    left, en coordonnees pleine resolution) et renvoie l'EAR moyen des deux
    yeux, ou None si les landmarks n'ont pas pu etre extraits.

    Optimisation performance : au lieu de convertir toute l'image BGR->RGB
    (l'operation la plus couteuse a chaque frame sur un flux HD), on ne
    decoupe et convertit que la petite zone du visage (+ marge). Le
    detecteur de landmarks dlib n'a de toute facon besoin que de cette
    region ; ca reduit fortement le cout CPU par rapport a une conversion
    plein cadre a chaque frame.
    """
    top, right, bottom, left = face_box
    h, w = frame_bgr.shape[:2]

    top_m = max(0, top - margin)
    left_m = max(0, left - margin)
    bottom_m = min(h, bottom + margin)
    right_m = min(w, right + margin)

    crop = frame_bgr[top_m:bottom_m, left_m:right_m]
    if crop.size == 0:
        return None

    rgb_crop = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
    box_in_crop = (top - top_m, right - left_m, bottom - top_m, left - left_m)

    landmarks_list = face_recognition.face_landmarks(rgb_crop, face_locations=[box_in_crop])
    if not landmarks_list:
        return None
    landmarks = landmarks_list[0]
    left_eye = landmarks.get("left_eye")
    right_eye = landmarks.get("right_eye")
    if not left_eye or not right_eye:
        return None
    ear_left = eye_aspect_ratio(left_eye)
    ear_right = eye_aspect_ratio(right_eye)
    values = [v for v in (ear_left, ear_right) if v is not None]
    if not values:
        return None
    return sum(values) / len(values)


class LivenessTracker:
    """Suit, par identite (cle libre : id membre, nom...), si un clignement
    des yeux a ete detecte recemment, afin de confirmer qu'il s'agit d'une
    personne reelle et pas d'une photo.
    """

    def __init__(self, ear_threshold=EAR_THRESHOLD, consec_frames=EAR_CONSEC_FRAMES,
                 blink_timeout=BLINK_TIMEOUT, reset_after=RESET_AFTER):
        self.ear_threshold = ear_threshold
        self.consec_frames = consec_frames
        self.blink_timeout = blink_timeout
        self.reset_after = reset_after
        self._states = {}

    def _new_state(self, now):
        return {
            "first_seen": now,
            "last_seen": now,
            "closed_frames": 0,
            "blinks": 0,
            "verified": False,
        }

    def reset(self, key):
        self._states.pop(key, None)

    def is_verified(self, key):
        """Renvoie True si `key` a deja ete verifiee (clignement detecte) et
        est toujours consideree presente (vue recemment). Permet d'eviter de
        relancer le calcul EAR (couteux : crop + conversion + landmarks
        dlib) une fois la liveness confirmee pour cette identite."""
        state = self._states.get(key)
        if state is None:
            return False
        if (time.time() - state["last_seen"]) > self.reset_after:
            return False
        return state["verified"]

    def cleanup(self):
        """A appeler periodiquement pour oublier les identites plus vues
        depuis longtemps (evite d'accumuler des entrees indefiniment)."""
        now = time.time()
        stale = [k for k, s in self._states.items() if (now - s["last_seen"]) > self.reset_after]
        for k in stale:
            self._states.pop(k, None)

    def update(self, key, ear):
        """A appeler a chaque frame ou l'identite `key` est detectee, avec
        l'EAR courant (ou None si indisponible pour cette frame).

        Retourne (verified: bool, remaining_seconds: float).
        `verified` reste True tant que la personne reste presente en continu
        une fois un clignement detecte (pas besoin de re-cligner a chaque
        frame). Si elle quitte le champ plus de `reset_after` secondes,
        l'etat est reinitialise et un nouveau clignement sera exige.
        """
        now = time.time()
        state = self._states.get(key)
        if state is None or (now - state["last_seen"]) > self.reset_after:
            state = self._new_state(now)
            self._states[key] = state

        state["last_seen"] = now

        if ear is not None:
            if ear < self.ear_threshold:
                state["closed_frames"] += 1
            else:
                if state["closed_frames"] >= self.consec_frames:
                    state["blinks"] += 1
                    state["verified"] = True
                state["closed_frames"] = 0

        elapsed = now - state["first_seen"]
        remaining = max(0.0, self.blink_timeout - elapsed)

        if not state["verified"] and elapsed > self.blink_timeout:
            # La fenetre expire sans clignement detecte : on en relance une
            # nouvelle plutot que de bloquer indefiniment (l'utilisateur peut
            # avoir ete mal detecte). L'acces reste refuse tant qu'aucun
            # clignement n'a ete vu.
            state["first_seen"] = now
            remaining = self.blink_timeout

        return state["verified"], remaining
