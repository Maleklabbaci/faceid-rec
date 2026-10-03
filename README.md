# FaceID Platform — Contrôle d'accès par abonnement (SaaS multi-secteurs)

Deux produits dans ce dépôt :

| | Dossier | Pour qui |
|---|---|---|
| **Plateforme web — édition Cloudflare (recommandée)** | `site/` + `functions/` | 100 % hébergée chez Cloudflare (Pages + Functions + D1), gratuite, « push → en ligne ». La reconnaissance faciale tourne dans le navigateur du kiosque. Guide : **[deploy/cloudflare-pages.md](deploy/cloudflare-pages.md)**. |
| **Plateforme web — édition auto-hébergée** | `web/` | Même produit en Flask + dlib pour un VPS / PC sur site, exposé via Cloudflare Tunnel. Guide : [deploy/cloudflare.md](deploy/cloudflare.md). |
| **Application bureau (historique)** | `app.py`, `main.py`, `register.py` | Un PC sur site avec webcam + éventuel relais Arduino pour ouvrir une porte. |

Les deux éditions web partagent le même produit (espace privé par entreprise, 4 secteurs, membres et abonnements, kiosque facial avec voix, journal et tableau de bord) et le même modèle de reconnaissance (ResNet 128-d de dlib ; `face-api.js` en est le portage navigateur).

---

## 0. Édition Cloudflare (Pages + Functions + D1) — mise en ligne en 6 réglages

```
site/                      interface statique (accueil, connexion, application, kiosque)
site/vendor/face-api.js    moteur facial navigateur (détection + empreinte 128-d)
site/models/               poids des 3 réseaux (≈ 6,5 Mo, mis en cache un an)
functions/api/[[route]].js API JSON : comptes, membres, enrôlement, reconnaissance, règles secteur, journal
schema.sql                 schéma D1 (créé automatiquement au premier appel)
tests/cloudflare.test.mjs  8 tests de bout en bout (npm test)
```

Réglages du projet Pages : *Build output directory* = `site`, base D1 `faceid` liée sous le nom **`DB`**, secret **`PEPPER`**, branche de production `main`. Détail pas à pas, dépannage de l'erreur SSL des URL de prévisualisation, domaine personnalisé : **[deploy/cloudflare-pages.md](deploy/cloudflare-pages.md)**.

```bash
npm install && npm run dev     # http://localhost:8788 avec une base D1 locale
npm test                       # tests API (démarre un serveur wrangler local)
```

Comment la reconnaissance fonctionne sans serveur : le kiosque calcule l'empreinte du visage dans le navigateur, la compare aux empreintes des membres de l'entreprise (téléchargées via `GET /api/descriptors`, consentement requis) et n'envoie que la décision (`POST /api/recognized`) ; l'API applique les règles (expiration, un repas/jour, retards, doublons 60 s) et tient le journal. Aucune image ne transite sur Internet.

---

## 1. Plateforme web — édition auto-hébergée (Flask)

### Lancer en local
```bash
python -m venv .venv && source .venv/bin/activate      # Windows : .venv\Scripts\activate
pip install -r requirements-web.txt
COOKIE_SECURE=0 python -m web.wsgi                      # http://localhost:5000
```
`COOKIE_SECURE=0` n'est nécessaire qu'en HTTP local. En production (HTTPS) ne le mettez pas.

### Moteur facial (le même que l'application bureau)
```bash
pip install dlib-bin numpy
pip install --no-deps face_recognition face_recognition_models
```
`dlib-bin` fournit dlib précompilé (Windows / Linux / macOS), ce qui évite CMake et Visual Studio. Sans ces modules, la plateforme fonctionne quand même : seules les actions « Enregistrer le visage » et « Vérifier » renvoient « moteur facial non installé », tout le reste (membres, abonnements, entrées manuelles, journal) reste utilisable.

Pour vérifier le moteur sur votre serveur avec une vraie photo :
```bash
FACE_TEST_IMAGE=/chemin/photo.jpg python -m pytest -q tests -k real_face
```

### Aperçu intégré (iframe) ou hébergeur de test
```bash
EMBED_PREVIEW=1 python -m web.wsgi
```
Autorise l'affichage dans une iframe d'un autre site (cookies `SameSite=None; Secure`). **La caméra exige HTTPS** ; si la fenêtre intégrée bloque la caméra, la page propose un lien « Ouvrir dans un nouvel onglet ».

### Les 4 cibles (secteur choisi à l'inscription, modifiable dans Paramètres)

| Secteur | Cible | Vocabulaire | Règle spécifique |
|---|---|---|---|
| `fitness` **(cible n°1)** | Salles de sport & clubs | membres / abonnement / passages | Abonnement vérifié à chaque passage |
| `office` | PME & bureaux (20-150 employés) | employés / contrat / pointages | Premier pointage du jour horodaté, **retard calculé** (heure de début + tolérance paramétrables), tableau « Présences du jour » |
| `coworking` | Coworking & centres de formation | clients / accès payé / entrées | Accès selon la date payée (raccourcis Journée / 1 mois / 3 mois / 1 an), **présents aujourd'hui** |
| `canteen` | Cantines d'entreprise & écoles privées | inscrits / inscription / repas | **Un repas par personne et par jour** (le 2ᵉ passage est refusé et annoncé), repas servis aujourd'hui |

Commun à tous : même personne reconnue deux fois en moins d'une minute = un seul enregistrement ; abonnement/contrat expiré = refus journalisé ; horodatage dans le fuseau de l'entreprise (Alger par défaut).

### Fonctionnalités
- **Espace privé par entreprise (multi-tenant)** : chaque compte ne voit que ses propres personnes et passages (vérifié par tests).
- **Inscription en 1 seconde** : taper le nom → « Ajouter et capturer » → la caméra s'ouvre, l'opérateur coche l'accord, compte à rebours 3-2-1, capture automatique (réessaie toute seule si personne n'est devant la caméra).
- **Kiosque** : caméra du navigateur en mode automatique (vérification toutes les 1,5 s, bandeau vert/orange/rouge), ou validation manuelle sans caméra. Le plus grand visage est retenu si plusieurs personnes passent devant la caméra.
- **Annonces vocales (voix féminine, gratuites)** : « Caméra activée, permission accordée », « Approchez-vous de la caméra », « Bienvenue Amine, accès autorisé », « Bonjour Karim, pointage enregistré », « Bon appétit Yanis ! », « Déjà enregistré aujourd'hui », « Accès refusé, abonnement expiré »… Synthèse vocale du navigateur (voix « Google français », Hortense, Denise…) qui dit le prénom ; si le navigateur n'a pas de voix féminine française, des clips enregistrés (`web/static/voice/`) prennent le relais. Bouton 🔊 pour couper.
- **Journal & tableau de bord** : indicateurs propres au secteur, graphique 7 jours, journal avec heure locale, résultat (Autorisé / Refusé / Retard).
- **Biométrie avec accord** : l'empreinte faciale n'est enregistrée qu'après une case d'accord explicite, et peut être effacée à tout moment ; supprimer une fiche efface aussi son historique.

### Sécurité incluse
Mots de passe hachés (Werkzeug), jeton CSRF sur tous les POST, cookies `HttpOnly`/`SameSite`/`Secure`, Content-Security-Policy stricte, limitation des tentatives de connexion/inscription, aucune page privée mise en cache.

### Tests
```bash
pip install pytest && python -m pytest -q tests
```

### Mettre en ligne l'édition auto-hébergée — avec Cloudflare Tunnel
Cette édition exécute le moteur facial natif (dlib) côté serveur ; **Cloudflare Tunnel** (gratuit) donne une URL HTTPS sur ton domaine à une app qui tourne sur ton PC ou un VPS, sans ouvrir de port. Tout est prêt :
```bash
cp .env.example .env          # SECRET_KEY + token du tunnel Cloudflare
docker compose up -d --build  # app (gunicorn + moteur facial) + cloudflared
```
Guide complet (VPS Docker, PC Windows sans Docker, test express `trycloudflare.com`, réglages Cloudflare à vérifier) : **[deploy/cloudflare.md](deploy/cloudflare.md)**.

Autres hébergeurs Python (Render, Railway, Fly.io, VPS + Nginx) : même image Docker ou `gunicorn --preload -w 2 -b 0.0.0.0:$PORT web.wsgi:app`.

Variables : `SECRET_KEY` (**obligatoire**), `WEB_DATABASE` (sur disque persistant ; la clé de session générée est stockée à côté), `TRUST_PROXY=1` derrière un proxy, `PRELOAD_FACE=1`, `COOKIE_SECURE=0` seulement en HTTP local. Supervision : `GET /healthz`.

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
