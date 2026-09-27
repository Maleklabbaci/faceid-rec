import sqlite3
import numpy as np
import os
import sys
from datetime import datetime


def get_base_dir():
    if getattr(sys, "frozen", False):
        data_dir = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "FaceID")
        os.makedirs(data_dir, exist_ok=True)
        return data_dir
    return os.path.dirname(os.path.abspath(__file__))


DB_PATH = os.path.join(get_base_dir(), "members.db")


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            encoding BLOB NOT NULL,
            subscription_end TEXT NOT NULL,
            photo_path TEXT,
            consent_given INTEGER NOT NULL DEFAULT 0,
            consent_date TEXT
        )
    """)
    # Migration douce : si la base existait deja avant l'ajout du consentement
    # (loi 18-07 sur les donnees biometriques), on ajoute les colonnes sans
    # perdre les membres deja enregistres.
    existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(members)")}
    if "consent_given" not in existing_cols:
        conn.execute("ALTER TABLE members ADD COLUMN consent_given INTEGER NOT NULL DEFAULT 0")
    if "consent_date" not in existing_cols:
        conn.execute("ALTER TABLE members ADD COLUMN consent_date TEXT")
    conn.commit()
    conn.close()


def add_member(name, encoding, subscription_end, photo_path=None, consent=False):
    """Enregistre un membre. `consent` doit valoir True uniquement si la
    personne a explicitement accepte que son visage (donnee biometrique)
    soit stocke (voir docs/formulaire_consentement.md) - cf. loi algerienne
    n 18-07 sur la protection des donnees personnelles."""
    conn = sqlite3.connect(DB_PATH)
    consent_date = datetime.now().strftime("%Y-%m-%d %H:%M") if consent else None
    conn.execute(
        "INSERT INTO members (name, encoding, subscription_end, photo_path, consent_given, consent_date) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (name, encoding.tobytes(), subscription_end, photo_path, 1 if consent else 0, consent_date),
    )
    conn.commit()
    conn.close()


def update_subscription(member_id, new_date):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("UPDATE members SET subscription_end = ? WHERE id = ?", (new_date, member_id))
    conn.commit()
    conn.close()


def get_all_members():
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT id, name, encoding, subscription_end, consent_given, consent_date FROM members"
    ).fetchall()
    conn.close()
    members = []
    for row in rows:
        members.append({
            "id": row[0],
            "name": row[1],
            "encoding": np.frombuffer(row[2], dtype=np.float64),
            "subscription_end": row[3],
            "consent_given": bool(row[4]),
            "consent_date": row[5],
        })
    return members
