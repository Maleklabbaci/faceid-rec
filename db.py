import sqlite3
import numpy as np
import os
import sys


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
            photo_path TEXT
        )
    """)
    conn.commit()
    conn.close()


def add_member(name, encoding, subscription_end, photo_path=None):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT INTO members (name, encoding, subscription_end, photo_path) VALUES (?, ?, ?, ?)",
        (name, encoding.tobytes(), subscription_end, photo_path),
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
    rows = conn.execute("SELECT id, name, encoding, subscription_end FROM members").fetchall()
    conn.close()
    members = []
    for row in rows:
        members.append({
            "id": row[0],
            "name": row[1],
            "encoding": np.frombuffer(row[2], dtype=np.float64),
            "subscription_end": row[3],
        })
    return members
