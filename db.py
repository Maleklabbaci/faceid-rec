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
    conn.execute("""
        CREATE TABLE IF NOT EXISTS access_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            member_id INTEGER,
            name TEXT NOT NULL,
            status TEXT NOT NULL,
            timestamp TEXT NOT NULL
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
    personne a accepte (implicitement ou explicitement) que son visage
    (donnee biometrique) soit stocke - voir docs/conformite_donnees.md."""
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


def delete_member(member_id):
    """Supprime definitivement un membre (donnee biometrique incluse) et sa
    photo associee si elle existe. Utilise pour le droit a l'effacement."""
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute("SELECT photo_path FROM members WHERE id = ?", (member_id,)).fetchone()
    conn.execute("DELETE FROM members WHERE id = ?", (member_id,))
    conn.commit()
    conn.close()
    if row and row[0]:
        try:
            os.remove(row[0])
        except OSError:
            pass


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


def log_access(name, status, member_id=None):
    """Enregistre une tentative d'acces (reconnu/refuse/expire) dans
    l'historique, pour pouvoir repondre a 'qui est entre et quand'."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT INTO access_log (member_id, name, status, timestamp) VALUES (?, ?, ?, ?)",
        (member_id, name, status, datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
    )
    conn.commit()
    conn.close()


def get_access_log(limit=500):
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT id, member_id, name, status, timestamp FROM access_log ORDER BY id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return [
        {"id": r[0], "member_id": r[1], "name": r[2], "status": r[3], "timestamp": r[4]}
        for r in rows
    ]
