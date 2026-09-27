"""Protection par mot de passe de l'application FaceID.

But : empecher que n'importe qui ouvrant l'ordinateur puisse lancer
l'application et voir la liste des membres / leurs visages. Au premier
lancement, on demande de creer un mot de passe ; ensuite, il est demande
a chaque demarrage.

Le mot de passe n'est jamais stocke en clair : on stocke un sel aleatoire
+ un hash PBKDF2 (methode standard, pas besoin de dependance externe).
"""

import hashlib
import json
import os
import secrets
import tkinter as tk
from tkinter import messagebox

from db import get_base_dir

AUTH_PATH = os.path.join(get_base_dir(), "auth.json")
MAX_ATTEMPTS = 5
PBKDF2_ITERATIONS = 100_000


def _hash_password(password, salt_hex):
    salt = bytes.fromhex(salt_hex)
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS).hex()


def is_configured():
    return os.path.exists(AUTH_PATH)


def set_password(password):
    salt_hex = secrets.token_hex(16)
    data = {"salt": salt_hex, "hash": _hash_password(password, salt_hex)}
    with open(AUTH_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f)


def verify_password(password):
    if not is_configured():
        return False
    with open(AUTH_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    return _hash_password(password, data["salt"]) == data["hash"]


class _LoginDialog(tk.Toplevel):
    def __init__(self, parent):
        super().__init__(parent)
        self.title("FaceID - Connexion")
        self.resizable(False, False)
        self.configure(padx=0, pady=0)
        self.result = False
        self.attempts = 0
        self.first_time = not is_configured()
        self.protocol("WM_DELETE_WINDOW", self._cancel)

        container = tk.Frame(self, padx=26, pady=22)
        container.pack()

        tk.Label(container, text="🔒 Face ID", font=("Segoe UI", 16, "bold")).pack(anchor="w", pady=(0, 4))

        if self.first_time:
            tk.Label(
                container,
                text="Premiere utilisation : creez un mot de passe\npour proteger l'acces a l'application.",
                justify="left", fg="#444",
            ).pack(anchor="w", pady=(0, 14))
        else:
            tk.Label(container, text="Entrez le mot de passe administrateur :", justify="left").pack(
                anchor="w", pady=(0, 10))

        self.pwd_entry = tk.Entry(container, show="*", width=30)
        self.pwd_entry.pack(pady=(0, 8))
        self.pwd_entry.focus_set()

        self.confirm_entry = None
        if self.first_time:
            tk.Label(container, text="Confirmez le mot de passe :").pack(anchor="w")
            self.confirm_entry = tk.Entry(container, show="*", width=30)
            self.confirm_entry.pack(pady=(4, 8))

        self.error_label = tk.Label(container, text="", fg="#DC2626")
        self.error_label.pack(pady=(2, 0))

        btn_frame = tk.Frame(container)
        btn_frame.pack(pady=(14, 0))
        tk.Button(btn_frame, text="Creer" if self.first_time else "Se connecter",
                  command=self._submit, width=14).pack(side="left", padx=4)
        tk.Button(btn_frame, text="Quitter", command=self._cancel, width=10).pack(side="left", padx=4)

        self.bind("<Return>", lambda e: self._submit())

        self.transient(parent)
        self.update_idletasks()
        self.grab_set()

    def _submit(self):
        pwd = self.pwd_entry.get()
        if self.first_time:
            confirm = self.confirm_entry.get()
            if len(pwd) < 4:
                self.error_label.configure(text="Mot de passe trop court (4 caracteres min).")
                return
            if pwd != confirm:
                self.error_label.configure(text="Les deux mots de passe ne correspondent pas.")
                self.confirm_entry.delete(0, "end")
                return
            set_password(pwd)
            self.result = True
            self.destroy()
        else:
            if verify_password(pwd):
                self.result = True
                self.destroy()
            else:
                self.attempts += 1
                remaining = MAX_ATTEMPTS - self.attempts
                self.pwd_entry.delete(0, "end")
                if remaining <= 0:
                    messagebox.showerror("Acces refuse", "Trop de tentatives incorrectes. Fermeture de l'application.")
                    self.result = False
                    self.destroy()
                else:
                    self.error_label.configure(text=f"Mot de passe incorrect ({remaining} essai(s) restant(s)).")

    def _cancel(self):
        self.result = False
        self.destroy()


def run_login_flow(parent):
    """Affiche la fenetre de connexion (ou de creation du mot de passe au
    tout premier lancement) et bloque jusqu'a ce qu'elle se ferme.
    Renvoie True si l'utilisateur est authentifie, False sinon."""
    dialog = _LoginDialog(parent)
    parent.wait_window(dialog)
    return dialog.result
