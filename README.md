# FaceID Platform — Contrôle d'accès par abonnement (SaaS multi-secteurs)

Deux produits dans ce dépôt :

| | Dossier | Pour qui |
|---|---|---|
| **Plateforme web (SaaS)** | `web/` | Vendre à plusieurs entreprises : chaque client crée son espace, gère ses membres/abonnements et contrôle les entrées depuis un navigateur. |
| **Application bureau (historique)** | `app.py`, `main.py`, `register.py` | Un PC sur site avec webcam + éventuel relais Arduino pour ouvrir une porte. |

---

## 1. Plateforme web

### Lancer en local
```bash
python -m venv .venv && source .venv/bin/activate      # Windows : .venv\Scripts\activate
pip install -r requirements-web.txt
COOKIE_SECURE=0 python -m web.wsgi                      # http://localhost:5000
```
`COOKIE_SECURE=0` n'est nécessaire qu'en HTTP local. En production (HTTPS) ne le mettez pas.

Pour activer la reconnaissance faciale côté serveur, installez en plus `pip install -r requirements.txt` (dlib / face_recognition). Sans ces modules, la plateforme fonctionne quand même : seules les actions « Enregistrer le visage » et « Vérifier l'accès » renvoient un message « module facial non installé », tout le reste (membres, abonnements, entrées manuelles, journal) reste utilisable.

### Fonctionnalités
- **Espace privé par entreprise (multi-tenant)** : inscription avec nom + secteur, chaque compte ne voit que ses propres membres et passages (vérifié par tests).
- **Secteurs** : Sport & fitness, Éducation, Coworking, Entreprises, Loisirs — l'espace change de couleurs selon le secteur, modifiable dans Paramètres.
- **Membres & abonnements** : ajout, date de fin, statut Actif/Expiré, renouvellement, suppression (efface aussi l'historique et les données biométriques).
- **Contrôle d'accès** : entrée manuelle (sans caméra) ou reconnaissance faciale depuis la caméra du navigateur ; un abonnement expiré est refusé (HTTP 409).
- **Journal & tableau de bord** : membres actifs, passages du jour, graphique 7 jours, derniers passages.
- **Biométrie avec consentement** : l'empreinte faciale n'est enregistrée qu'après une case de consentement explicite, et peut être effacée à tout moment.

### Sécurité incluse
Mots de passe hachés (Werkzeug), jeton CSRF sur tous les POST, cookies `HttpOnly`/`SameSite`/`Secure`, Content-Security-Policy stricte, limitation des tentatives de connexion/inscription, aucune page privée mise en cache.

### Tests
```bash
pip install pytest && python -m pytest -q tests
```

### Mettre en ligne (production)
Toute plateforme Python convient (Render, Railway, Fly.io, un VPS avec Nginx…). Commande de démarrage :
```bash
gunicorn -w 2 -b 0.0.0.0:$PORT web.wsgi:app
```
Variables d'environnement :
- `SECRET_KEY` — **obligatoire** en production (ex. `python -c "import secrets;print(secrets.token_hex(32))"`).
- `WEB_DATABASE` — chemin du fichier SQLite, à placer sur un **disque persistant** (ex. `/data/web.db`).
- `COOKIE_SECURE` — laisser à `1` (HTTPS). La caméra du navigateur exige HTTPS.

Base SQLite = suffisant pour démarrer et les premiers clients. Prévoir PostgreSQL au-delà (quelques dizaines d'entreprises actives en même temps).

### Ce qui reste à faire avant de vendre
- Paiement en ligne (Stripe / CIB-Edahabia selon le marché) et limites par formule.
- Conditions d'utilisation + politique de confidentialité (données biométriques = données sensibles, loi 18-07 en Algérie / RGPD en Europe).
- Email de réinitialisation de mot de passe, plusieurs administrateurs par entreprise.
- Pilotage d'une porte / tourniquet : nécessite toujours un petit boîtier sur site (Arduino/ESP32) qui interroge la plateforme.

---

## 2. Application bureau (Windows)

### Installation
```bash
pip install -r requirements.txt
```
Sur Windows, `dlib` demande souvent CMake + Visual Studio Build Tools (`pip install cmake` puis `pip install dlib`, ou `conda install -c conda-forge dlib`).

### Utilisation
- `python app.py` → interface unique (Membres / Enregistrer / Reconnaissance), base `members.db`.
- `python register.py` puis `python main.py` → alternative en ligne de commande.

### Créer un installeur Windows
`build_all.bat` installe les dépendances, compile l'exe (PyInstaller) puis l'installeur (Inno Setup) → `installer_output/FaceID_Setup.exe`. Prérequis : Python (« Add to PATH ») et Inno Setup. Détails : `build_windows.bat`, `installer.iss`. Les données (`members.db`, `photos/`, `error.log`) vont dans `%APPDATA%\FaceID` une fois installé.

### Accès physique
Mettre `USE_ARDUINO = True` dans `main.py` / `app.py`, brancher un Arduino/ESP32 + relais sur la gâche : le script envoie `OPEN\n` en série quand l'accès est autorisé.
