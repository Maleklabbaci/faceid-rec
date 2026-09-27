import tkinter as tk
from tkinter import ttk, messagebox
import cv2
from PIL import Image, ImageTk, ImageDraw, ImageFont
import face_recognition
import numpy as np
from datetime import datetime
import sys
import os
import traceback

from db import init_db, add_member, update_subscription, get_all_members, get_base_dir
from liveness import LivenessTracker, compute_ear_from_landmarks

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------
USE_ARDUINO = False
ARDUINO_PORT = "COM3"
TOLERANCE = 0.5
REQUIRE_BLINK = True  # Anti-spoofing : exige un clignement des yeux avant d'ouvrir l'accès

# Certains pilotes de webcam (surtout via le backend DirectShow / CAP_DSHOW sous
# Windows) renvoient un flux dont les lignes sont stockees "bottom-up", ce qui
# fait apparaitre l'image inversee verticalement. On corrige ca ici, puis on
# applique un effet miroir horizontal pour un rendu "selfie" naturel.
FIX_DRIVER_VERTICAL_FLIP = True
MIRROR_PREVIEW = True

VIDEO_BOX_SIZE = (560, 400)  # taille d'affichage (largeur, hauteur) des apercus camera

LOG_PATH = os.path.join(get_base_dir(), "error.log")


def log_crash(exc_type, exc_value, exc_tb):
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write("".join(traceback.format_exception(exc_type, exc_value, exc_tb)))
    try:
        messagebox.showerror("Erreur", f"Une erreur est survenue.\nVoir : {LOG_PATH}")
    except Exception:
        pass


sys.excepthook = log_crash

init_db()

arduino = None
if USE_ARDUINO:
    import serial
    arduino = serial.Serial(ARDUINO_PORT, 9600)


# ----------------------------------------------------------------------------
# Palette / theme
# ----------------------------------------------------------------------------
class Theme:
    bg_sidebar = "#161B2E"
    bg_sidebar_active = "#232A45"
    bg_app = "#F4F5F9"
    bg_card = "#FFFFFF"
    border = "#E4E6EF"

    text_main = "#1A1D29"
    text_muted = "#6B7280"
    text_on_dark = "#E7E9F5"
    text_on_dark_muted = "#8A90AC"

    accent = "#5B5FEF"
    accent_hover = "#4A4EDB"
    accent_soft = "#EEF0FF"

    success = "#16A34A"
    success_soft = "#E7F7ED"
    danger = "#DC2626"
    danger_soft = "#FDEDED"
    warning = "#D97706"
    warning_soft = "#FEF3E2"
    neutral = "#6B7280"
    neutral_soft = "#EEF0F4"
    info = "#2563EB"
    info_soft = "#EAF1FE"

    font_family = "Segoe UI"


def style_button(widget, bg, fg, hover_bg, font=None, padx=18, pady=10):
    """Bouton flat avec effet hover, sans dependre de ttk (rendu plus fiable multi-OS)."""
    widget.configure(
        bg=bg, fg=fg, activebackground=hover_bg, activeforeground=fg,
        bd=0, relief="flat", cursor="hand2",
        font=font or (Theme.font_family, 10, "bold"),
        padx=padx, pady=pady, highlightthickness=0,
    )
    widget.bind("<Enter>", lambda e: widget.configure(bg=hover_bg))
    widget.bind("<Leave>", lambda e: widget.configure(bg=bg))


def rounded_badge(parent, text, fg, bg):
    return tk.Label(parent, text=text, fg=fg, bg=bg, font=(Theme.font_family, 11, "bold"),
                     padx=16, pady=8)


def placeholder_frame(size, message):
    """Image de secours (camera indisponible) affichee dans les apercus video."""
    w, h = size
    img = Image.new("RGB", (w, h), "#1F2433")
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("segoeui.ttf", 16)
    except Exception:
        font = ImageFont.load_default()
    bbox = draw.textbbox((0, 0), message, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(((w - tw) / 2, (h - th) / 2), message, fill="#8A90AC", font=font)
    return img


# ----------------------------------------------------------------------------
# Application
# ----------------------------------------------------------------------------
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Face ID - Controle d'acces")
        self.geometry("1080x680")
        self.minsize(920, 600)
        self.configure(bg=Theme.bg_app)

        self._init_ttk_style()

        self.cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
        if not self.cap.isOpened():
            self.cap = cv2.VideoCapture(0)
        self.camera_ok = self.cap.isOpened()
        if not self.camera_ok:
            messagebox.showerror(
                "Erreur",
                "Impossible d'ouvrir la camera (index 0).\n"
                "Verifiez Parametres > Confidentialite > Camera > autoriser les applications de bureau.",
            )

        self.last_frame = None
        self.members = []
        self.last_notified_id = None
        self.nav_buttons = {}
        self.active_view = "members"
        self.liveness_tracker = LivenessTracker()

        self.reload_members()
        self.build_layout()
        self.show_view("members")

        self.update_frame()
        self.update_clock()
        self.protocol("WM_DELETE_WINDOW", self.on_close)

    # ---------- Style ttk (Treeview / Entry) ----------
    def _init_ttk_style(self):
        style = ttk.Style(self)
        style.theme_use("clam")

        style.configure(
            "Faceid.Treeview",
            background=Theme.bg_card,
            fieldbackground=Theme.bg_card,
            foreground=Theme.text_main,
            rowheight=34,
            borderwidth=0,
            font=(Theme.font_family, 10),
        )
        style.map("Faceid.Treeview", background=[("selected", Theme.accent_soft)],
                  foreground=[("selected", Theme.text_main)])
        style.configure(
            "Faceid.Treeview.Heading",
            background=Theme.bg_card,
            foreground=Theme.text_muted,
            font=(Theme.font_family, 9, "bold"),
            borderwidth=0,
            relief="flat",
        )
        style.layout("Faceid.Treeview", [("Treeview.treearea", {"sticky": "nswe"})])

        style.configure("Faceid.TEntry", fieldbackground="#FFFFFF", bordercolor=Theme.border,
                         padding=8, relief="flat")

    # ---------- Layout general : sidebar + zone de contenu ----------
    def build_layout(self):
        self.sidebar = tk.Frame(self, bg=Theme.bg_sidebar, width=230)
        self.sidebar.pack(side="left", fill="y")
        self.sidebar.pack_propagate(False)

        self.content = tk.Frame(self, bg=Theme.bg_app)
        self.content.pack(side="right", fill="both", expand=True)

        self.build_sidebar()

        # Une frame par vue, empilees au meme endroit (on utilise tkraise)
        self.view_members = tk.Frame(self.content, bg=Theme.bg_app)
        self.view_register = tk.Frame(self.content, bg=Theme.bg_app)
        self.view_scan = tk.Frame(self.content, bg=Theme.bg_app)
        for v in (self.view_members, self.view_register, self.view_scan):
            v.place(x=0, y=0, relwidth=1, relheight=1)

        self.build_members_view()
        self.build_register_view()
        self.build_scan_view()

    def build_sidebar(self):
        header = tk.Frame(self.sidebar, bg=Theme.bg_sidebar)
        header.pack(fill="x", pady=(28, 10), padx=22)
        tk.Label(header, text="🔒", bg=Theme.bg_sidebar, fg=Theme.accent,
                 font=(Theme.font_family, 22)).pack(anchor="w")
        tk.Label(header, text="Face ID", bg=Theme.bg_sidebar, fg=Theme.text_on_dark,
                 font=(Theme.font_family, 16, "bold")).pack(anchor="w", pady=(6, 0))
        tk.Label(header, text="Controle d'acces", bg=Theme.bg_sidebar, fg=Theme.text_on_dark_muted,
                 font=(Theme.font_family, 9)).pack(anchor="w")

        sep = tk.Frame(self.sidebar, bg=Theme.bg_sidebar_active, height=1)
        sep.pack(fill="x", padx=22, pady=(14, 18))

        nav_items = [
            ("members", "👥", "Membres"),
            ("register", "🧾", "Enregistrer"),
            ("scan", "🛡️", "Reconnaissance"),
        ]
        for key, icon, label in nav_items:
            self.build_nav_button(key, icon, label)

        # Bas de sidebar : etat camera + horloge
        bottom = tk.Frame(self.sidebar, bg=Theme.bg_sidebar)
        bottom.pack(side="bottom", fill="x", padx=22, pady=22)

        cam_row = tk.Frame(bottom, bg=Theme.bg_sidebar)
        cam_row.pack(fill="x", pady=(0, 10))
        dot_color = Theme.success if self.camera_ok else Theme.danger
        self.cam_dot = tk.Label(cam_row, text="●", bg=Theme.bg_sidebar, fg=dot_color,
                                 font=(Theme.font_family, 10))
        self.cam_dot.pack(side="left")
        tk.Label(cam_row, text=" Camera active" if self.camera_ok else " Camera indisponible",
                 bg=Theme.bg_sidebar, fg=Theme.text_on_dark_muted,
                 font=(Theme.font_family, 9)).pack(side="left")

        self.clock_label = tk.Label(bottom, text="", bg=Theme.bg_sidebar, fg=Theme.text_on_dark_muted,
                                     font=(Theme.font_family, 9))
        self.clock_label.pack(anchor="w")

    def build_nav_button(self, key, icon, label):
        row = tk.Frame(self.sidebar, bg=Theme.bg_sidebar)
        row.pack(fill="x", padx=12, pady=3)

        btn = tk.Label(row, text=f"  {icon}   {label}", bg=Theme.bg_sidebar, fg=Theme.text_on_dark_muted,
                       font=(Theme.font_family, 11), anchor="w", padx=10, pady=12, cursor="hand2")
        btn.pack(fill="x")
        btn.bind("<Button-1>", lambda e, k=key: self.show_view(k))
        btn.bind("<Enter>", lambda e, k=key: self._nav_hover(k, True))
        btn.bind("<Leave>", lambda e, k=key: self._nav_hover(k, False))
        self.nav_buttons[key] = btn

    def _nav_hover(self, key, entering):
        if key == self.active_view:
            return
        btn = self.nav_buttons[key]
        btn.configure(bg=Theme.bg_sidebar_active if entering else Theme.bg_sidebar)

    def show_view(self, key):
        self.active_view = key
        for k, btn in self.nav_buttons.items():
            if k == key:
                btn.configure(bg=Theme.bg_sidebar_active, fg=Theme.text_on_dark,
                              font=(Theme.font_family, 11, "bold"))
            else:
                btn.configure(bg=Theme.bg_sidebar, fg=Theme.text_on_dark_muted,
                              font=(Theme.font_family, 11, "normal"))
        {"members": self.view_members, "register": self.view_register, "scan": self.view_scan}[key].tkraise()
        if key == "members":
            self.reload_members()

    def update_clock(self):
        self.clock_label.config(text=datetime.now().strftime("%A %d %B %Y - %H:%M"))
        self.after(1000, self.update_clock)

    # ---------- Aide UI : carte + en-tete de page ----------
    def page_header(self, parent, title, subtitle):
        wrap = tk.Frame(parent, bg=Theme.bg_app)
        wrap.pack(fill="x", padx=36, pady=(30, 18))
        tk.Label(wrap, text=title, bg=Theme.bg_app, fg=Theme.text_main,
                 font=(Theme.font_family, 20, "bold")).pack(anchor="w")
        tk.Label(wrap, text=subtitle, bg=Theme.bg_app, fg=Theme.text_muted,
                 font=(Theme.font_family, 10)).pack(anchor="w", pady=(2, 0))

    def make_card(self, parent):
        """Cree une 'carte' (bordure fine + fond blanc) et la retourne SANS la placer.
        L'appelant choisit lui-meme pack() ou grid() sur la frame renvoyee."""
        outer = tk.Frame(parent, bg=Theme.border)
        inner = tk.Frame(outer, bg=Theme.bg_card)
        inner.pack(fill="both", expand=True, padx=1, pady=1)
        inner.outer = outer  # reference pour pouvoir placer 'outer' via inner.outer
        return inner

    # ================= Vue : Membres =================
    def build_members_view(self):
        parent = self.view_members
        self.page_header(parent, "Membres", "Gerez les abonnements et renouvelez les acces.")

        body = tk.Frame(parent, bg=Theme.bg_app)
        body.pack(fill="both", expand=True, padx=36, pady=(0, 30))

        list_card = self.make_card(body)
        list_card.outer.pack(fill="both", expand=True)

        cols = ("id", "name", "sub_end")
        self.tree = ttk.Treeview(list_card, columns=cols, show="headings", style="Faceid.Treeview")
        headings = {"id": "ID", "name": "Nom", "sub_end": "Fin d'abonnement"}
        widths = {"id": 70, "name": 320, "sub_end": 200}
        for c in cols:
            self.tree.heading(c, text=headings[c])
            self.tree.column(c, width=widths[c], anchor="w")
        self.tree.pack(fill="both", expand=True, padx=16, pady=16)
        self.tree.tag_configure("odd", background="#FAFAFC")
        self.tree.tag_configure("even", background=Theme.bg_card)

        renew_card = self.make_card(body)
        renew_card.outer.pack(fill="x", pady=(16, 0))
        renew_inner = tk.Frame(renew_card, bg=Theme.bg_card)
        renew_inner.pack(fill="x", padx=16, pady=14)

        tk.Label(renew_inner, text="Renouveler l'abonnement du membre selectionne",
                 bg=Theme.bg_card, fg=Theme.text_main, font=(Theme.font_family, 10, "bold")).grid(
            row=0, column=0, columnspan=3, sticky="w", pady=(0, 8))

        tk.Label(renew_inner, text="Nouvelle date (AAAA-MM-JJ)", bg=Theme.bg_card,
                 fg=Theme.text_muted, font=(Theme.font_family, 9)).grid(row=1, column=0, sticky="w")
        self.renew_entry = ttk.Entry(renew_inner, style="Faceid.TEntry", width=20)
        self.renew_entry.grid(row=2, column=0, sticky="w", pady=(4, 0))

        renew_btn = tk.Button(renew_inner, text="Renouveler", command=self.renew_selected)
        style_button(renew_btn, Theme.accent, "white", Theme.accent_hover)
        renew_btn.grid(row=2, column=1, sticky="w", padx=(14, 0), pady=(4, 0))

    def reload_members(self):
        self.members = get_all_members()
        if hasattr(self, "tree"):
            self.tree.delete(*self.tree.get_children())
            for i, m in enumerate(self.members):
                tag = "even" if i % 2 == 0 else "odd"
                self.tree.insert("", "end", iid=m["id"], values=(m["id"], m["name"], m["subscription_end"]),
                                  tags=(tag,))

    def renew_selected(self):
        sel = self.tree.selection()
        date_str = self.renew_entry.get().strip()
        if not sel or not date_str:
            messagebox.showwarning("Info", "Selectionnez un membre et entrez une date.")
            return
        try:
            datetime.strptime(date_str, "%Y-%m-%d")
        except ValueError:
            messagebox.showerror("Erreur", "Format de date invalide (AAAA-MM-JJ).")
            return
        update_subscription(int(sel[0]), date_str)
        self.reload_members()

    # ================= Vue : Enregistrer =================
    def build_register_view(self):
        parent = self.view_register
        self.page_header(parent, "Enregistrer un membre", "Capturez un visage et associez-le a un abonnement.")

        body = tk.Frame(parent, bg=Theme.bg_app)
        body.pack(fill="both", expand=True, padx=36, pady=(0, 30))
        body.columnconfigure(0, weight=3)
        body.columnconfigure(1, weight=2)
        body.rowconfigure(0, weight=1)

        video_card = self.make_card(body)
        video_card.outer.grid(row=0, column=0, sticky="nsew", padx=(0, 18))
        video_inner = tk.Frame(video_card, bg=Theme.bg_card)
        video_inner.pack(fill="both", expand=True, padx=16, pady=16)

        self.reg_video_label = tk.Label(video_inner, bg="#1F2433")
        self.reg_video_label.pack()

        self.reg_status = rounded_badge(video_inner, "Aucun visage detecte", Theme.danger, Theme.danger_soft)
        self.reg_status.pack(pady=(14, 0))

        form_card = self.make_card(body)
        form_card.outer.grid(row=0, column=1, sticky="nsew")
        form_inner = tk.Frame(form_card, bg=Theme.bg_card)
        form_inner.pack(fill="both", expand=True, padx=22, pady=22)

        tk.Label(form_inner, text="Informations du membre", bg=Theme.bg_card, fg=Theme.text_main,
                 font=(Theme.font_family, 12, "bold")).pack(anchor="w", pady=(0, 16))

        tk.Label(form_inner, text="Nom", bg=Theme.bg_card, fg=Theme.text_muted,
                 font=(Theme.font_family, 9)).pack(anchor="w")
        self.name_entry = ttk.Entry(form_inner, style="Faceid.TEntry")
        self.name_entry.pack(fill="x", pady=(4, 14))

        tk.Label(form_inner, text="Fin d'abonnement (AAAA-MM-JJ)", bg=Theme.bg_card, fg=Theme.text_muted,
                 font=(Theme.font_family, 9)).pack(anchor="w")
        self.date_entry = ttk.Entry(form_inner, style="Faceid.TEntry")
        self.date_entry.pack(fill="x", pady=(4, 22))

        capture_btn = tk.Button(form_inner, text="📸  Capturer & enregistrer", command=self.capture_member)
        style_button(capture_btn, Theme.accent, "white", Theme.accent_hover)
        capture_btn.pack(fill="x")

        tk.Label(form_inner, text="Placez-vous face a la camera jusqu'a ce que le badge\n"
                                   "passe au vert, puis remplissez le formulaire.",
                 bg=Theme.bg_card, fg=Theme.text_muted, font=(Theme.font_family, 9),
                 justify="left").pack(anchor="w", pady=(16, 0))

    def capture_member(self):
        name = self.name_entry.get().strip()
        date_str = self.date_entry.get().strip()
        if not name or not date_str:
            messagebox.showwarning("Info", "Remplissez le nom et la date.")
            return
        try:
            datetime.strptime(date_str, "%Y-%m-%d")
        except ValueError:
            messagebox.showerror("Erreur", "Format de date invalide (AAAA-MM-JJ).")
            return
        if self.last_frame is None:
            messagebox.showerror("Erreur", "Pas de flux camera.")
            return

        rgb = cv2.cvtColor(self.last_frame, cv2.COLOR_BGR2RGB)
        encs = face_recognition.face_encodings(rgb)
        if not encs:
            messagebox.showerror("Erreur", "Aucun visage detecte.")
            return

        add_member(name, encs[0], date_str)
        messagebox.showinfo("OK", f"{name} enregistre jusqu'au {date_str}.")
        self.name_entry.delete(0, "end")
        self.date_entry.delete(0, "end")
        self.reload_members()

    # ================= Vue : Reconnaissance =================
    def build_scan_view(self):
        parent = self.view_scan
        self.page_header(parent, "Reconnaissance", "Flux camera en direct avec verification d'acces.")

        body = tk.Frame(parent, bg=Theme.bg_app)
        body.pack(fill="both", expand=True, padx=36, pady=(0, 30))

        video_card = self.make_card(body)
        video_card.outer.pack(fill="both", expand=True)
        video_inner = tk.Frame(video_card, bg=Theme.bg_card)
        video_inner.pack(fill="both", expand=True, padx=16, pady=16)

        self.scan_video_label = tk.Label(video_inner, bg="#1F2433")
        self.scan_video_label.pack(pady=(0, 16))

        self.scan_status = rounded_badge(video_inner, "En attente...", Theme.neutral, Theme.neutral_soft)
        self.scan_status.configure(font=(Theme.font_family, 13, "bold"))
        self.scan_status.pack()

    # ---------- Boucle video partagee ----------
    def update_frame(self):
        if not self.camera_ok:
            img = placeholder_frame(VIDEO_BOX_SIZE, "Camera indisponible")
            imgtk = ImageTk.PhotoImage(image=img)
            for lbl in (getattr(self, "reg_video_label", None), getattr(self, "scan_video_label", None)):
                if lbl is not None:
                    lbl.imgtk = imgtk
                    lbl.configure(image=imgtk)
            self.after(500, self.update_frame)
            return

        ret, frame = self.cap.read()
        if ret:
            if FIX_DRIVER_VERTICAL_FLIP:
                frame = cv2.flip(frame, 0)
            if MIRROR_PREVIEW:
                frame = cv2.flip(frame, 1)
            self.last_frame = frame.copy()

            if self.active_view == "scan":
                frame, status_text, status_kind = self.process_recognition(frame)
                self.set_status_badge(self.scan_status, status_text, status_kind)
                self.render(frame, self.scan_video_label)
            elif self.active_view == "register":
                frame, detected = self.process_register_preview(frame)
                if detected:
                    self.set_status_badge(self.reg_status, "Visage detecte - pret a capturer", "success")
                else:
                    self.set_status_badge(self.reg_status, "Aucun visage detecte", "danger")
                self.render(frame, self.reg_video_label)

        self.after(30, self.update_frame)

    def set_status_badge(self, label, text, kind):
        palette = {
            "success": (Theme.success, Theme.success_soft),
            "danger": (Theme.danger, Theme.danger_soft),
            "warning": (Theme.warning, Theme.warning_soft),
            "neutral": (Theme.neutral, Theme.neutral_soft),
            "info": (Theme.info, Theme.info_soft),
        }
        fg, bg = palette.get(kind, palette["neutral"])
        label.configure(text=text, fg=fg, bg=bg)

    def process_recognition(self, frame):
        small = cv2.resize(frame, (0, 0), fx=0.25, fy=0.25)
        rgb_small = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
        rgb_full = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        locations = face_recognition.face_locations(rgb_small)
        encodings = face_recognition.face_encodings(rgb_small, locations)

        known_ids = [m["id"] for m in self.members]
        known_encodings = [m["encoding"] for m in self.members]
        known_names = [m["name"] for m in self.members]
        known_subs = [m["subscription_end"] for m in self.members]

        status_text, status_kind = "En attente...", "neutral"
        current_id = None

        for (top, right, bottom, left), face_encoding in zip(locations, encodings):
            top, right, bottom, left = top * 4, right * 4, bottom * 4, left * 4
            name, color = "Inconnu", (0, 0, 255)

            if known_encodings:
                matches = face_recognition.compare_faces(known_encodings, face_encoding, tolerance=TOLERANCE)
                distances = face_recognition.face_distance(known_encodings, face_encoding)
                if True in matches:
                    idx = int(np.argmin(distances))
                    if matches[idx]:
                        name = known_names[idx]
                        if datetime.now() <= datetime.strptime(known_subs[idx], "%Y-%m-%d"):
                            if REQUIRE_BLINK:
                                ear = compute_ear_from_landmarks(rgb_full, (top, right, bottom, left))
                                verified, remaining = self.liveness_tracker.update(known_ids[idx], ear)
                                if verified:
                                    status_text = f"{name.upper()} - ACCES AUTORISE"
                                    status_kind = "success"
                                    color = (0, 200, 90)
                                    if arduino:
                                        arduino.write(b"OPEN\n")
                                else:
                                    status_text = f"{name.upper()} - CLIGNEZ DES YEUX POUR VERIFIER ({int(remaining) + 1}s)"
                                    status_kind = "info"
                                    color = (235, 149, 34)
                            else:
                                status_text = f"{name.upper()} - ACCES AUTORISE"
                                status_kind = "success"
                                color = (0, 200, 90)
                                if arduino:
                                    arduino.write(b"OPEN\n")
                        else:
                            status_text = f"{name.upper()} - ABONNEMENT EXPIRE"
                            status_kind = "warning"
                            color = (0, 165, 255)
                            if REQUIRE_BLINK:
                                self.liveness_tracker.reset(known_ids[idx])
                    else:
                        status_text, status_kind = "ACCES REFUSE", "danger"
                else:
                    status_text, status_kind = "ACCES REFUSE", "danger"

            cv2.rectangle(frame, (left, top), (right, bottom), color, 2)
            cv2.putText(frame, name, (left + 6, top - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

            if current_id is None:
                current_id = name  # on ne notifie que pour le premier visage detecte

        if REQUIRE_BLINK:
            self.liveness_tracker.cleanup()

        if current_id is None:
            self.last_notified_id = None
        elif current_id != self.last_notified_id:
            self.last_notified_id = current_id
            if current_id == "Inconnu":
                self.show_notification("Visage inconnu detecte - veuillez enregistrer la personne", Theme.danger)
            else:
                self.show_notification(f"{current_id} a ete reconnu", Theme.success)

        return frame, status_text, status_kind

    def show_notification(self, message, color):
        notif = tk.Toplevel(self)
        notif.overrideredirect(True)
        notif.attributes("-topmost", True)
        notif.configure(bg=color)
        label = tk.Label(notif, text=message, bg=color, fg="white",
                          font=(Theme.font_family, 11, "bold"), padx=18, pady=12, wraplength=320, justify="left")
        label.pack()
        self.update_idletasks()
        x = self.winfo_x() + self.winfo_width() - 360
        y = self.winfo_y() + 40
        notif.geometry(f"+{x}+{y}")
        notif.after(3500, notif.destroy)

    def process_register_preview(self, frame):
        small = cv2.resize(frame, (0, 0), fx=0.25, fy=0.25)
        rgb_small = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
        locations = face_recognition.face_locations(rgb_small)
        for (top, right, bottom, left) in locations:
            top, right, bottom, left = top * 4, right * 4, bottom * 4, left * 4
            cv2.rectangle(frame, (left, top), (right, bottom), (91, 95, 239), 2)
        return frame, len(locations) > 0

    def render(self, frame, label_widget):
        h, w = frame.shape[:2]
        box_w, box_h = VIDEO_BOX_SIZE
        scale = min(box_w / w, box_h / h)
        new_w, new_h = int(w * scale), int(h * scale)

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        img = Image.fromarray(rgb).resize((new_w, new_h))

        canvas = Image.new("RGB", (box_w, box_h), "#1F2433")
        canvas.paste(img, ((box_w - new_w) // 2, (box_h - new_h) // 2))

        imgtk = ImageTk.PhotoImage(image=canvas)
        label_widget.imgtk = imgtk
        label_widget.configure(image=imgtk)

    def on_close(self):
        if self.cap is not None:
            self.cap.release()
        self.destroy()


if __name__ == "__main__":
    try:
        App().mainloop()
    except Exception:
        log_crash(*sys.exc_info())
