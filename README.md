# Face ID - Contrôle d'accès par abonnement

## Installation

⚠️ **Ne faites pas simplement `pip install -r requirements.txt`** — sur Windows, `face_recognition` déclare une dépendance sur le paquet `dlib` (à compiler depuis les sources, nécessite CMake + Visual Studio C++), même si `dlib-bin` (une version précompilée, sans compilation nécessaire) est installée. Pip ne fait pas le lien entre les deux et tente quand même de recompiler `dlib` depuis zéro → échec si Visual Studio n'est pas installé.

**Faites plutôt, dans l'ordre, en 2 commandes :**
```bash
pip install opencv-python numpy pyserial Pillow dlib-bin face_recognition_models
pip install face_recognition --no-deps
```
Le `--no-deps` sur la deuxième ligne est essentiel : il empêche pip de retélécharger/recompiler `dlib` puisque `dlib-bin` fait déjà le travail.

Vérifiez que tout est bien installé :
```bash
python -c "import cv2, face_recognition, numpy, PIL; print('OK')"
```

*(`build_all.bat`, decrit plus bas, fait deja tout ca automatiquement dans le bon ordre.)*

## Utilisation

### Interface unique (recommandé)
```bash
python app.py
```
Un écran de connexion protège l'accès à l'application (mot de passe créé au premier lancement, voir section [Sécurité / connexion](#sécurité--connexion)). Une fois connecté : une fenêtre avec 4 onglets : **Membres** (liste, renouvellement, suppression), **Enregistrer** (webcam + nom + date), **Reconnaissance** (flux live avec statut d'accès), **Historique** (journal des accès, exportable en CSV). Tout est relié à la même base `members.db`.

### Scripts séparés (alternative en ligne de commande)
1. `python register.py` → enregistrement d'un membre
2. `python main.py` → reconnaissance en direct

## Créer un vrai logiciel installable (icône bureau + menu Démarrer)

**En un clic (après une installation ponctuelle des outils)** : lancez `build_all.bat`. Il installe les dépendances, compile l'exe, puis compile l'installeur automatiquement (si Inno Setup est présent) → `installer_output/FaceID_Setup.exe`.

Prérequis à installer **une seule fois** sur le PC :
- [Python](https://python.org) (avec "Add to PATH" coché à l'installation)
- [Inno Setup](https://jrsoftware.org/isdl.php) (gratuit)

Une fois ces deux-là installés, `build_all.bat` fait tout le reste automatiquement, sans autre manipulation.

### Détail étape par étape (si besoin de déboguer)

**Étape 1 — Compiler l'exe** : lancez `build_windows.bat`.
- Il compile d'abord `FaceID_debug.exe` (avec console) : lancez-le pour vérifier qu'aucune erreur ne s'affiche. C'est l'étape qui manquait avant — sans elle, les erreurs de démarrage étaient invisibles.
- Puis il compile `FaceID.exe` final (sans console).
- Si une erreur apparaît quand même une fois lancé, elle est maintenant écrite dans `error.log` à côté de l'exe (plus jamais "silencieux").

**Étape 2 — Créer l'installeur** :
1. Installez [Inno Setup](https://jrsoftware.org/isinfo.php) (gratuit).
2. Ouvrez `installer.iss` avec Inno Setup, cliquez "Compile".
3. Vous obtenez `installer_output/FaceID_Setup.exe` : un vrai installeur qui met FaceID dans Program Files, crée un raccourci Bureau + Menu Démarrer, comme n'importe quel logiciel Windows.

Note : `members.db`, `photos/` et `error.log` sont créés dans `%APPDATA%\FaceID` une fois l'app installée (ex : `C:\Users\<toi>\AppData\Roaming\FaceID`), car `Program Files` est protégé en écriture. En mode développement (`python app.py`), ils restent à côté du script.

## Cas d'usage
- **PC perso** : lancer `main.py` en tâche de fond, `open_access()` peut déverrouiller une session ou une app.
- **Salle de jeux (accès physique)** : mettre `USE_ARDUINO = True` dans `main.py`, brancher un Arduino/ESP32 + relais électromécanique sur la gâche de porte. Le script envoie `OPEN\n` en série quand l'accès est autorisé.

## Vendre / déployer FaceID (Algérie)
Le dossier `docs/` contient de quoi démarcher des clients en toute légalité :
- `docs/argumentaire_vente.md` — argumentaire prêt à présenter (salles de sport, salles de jeux, coworking, écoles, résidences...).
- `docs/formulaire_consentement.md` — formulaire papier à faire signer avant d'enregistrer le visage de quelqu'un.
- `docs/conformite_donnees.md` — checklist de conformité (loi n° 18-07, ANPDP) et bonnes pratiques de sécurité.

Le logiciel exige désormais une confirmation de consentement (case à cocher dans `app.py`, question dans `register.py`) avant d'enregistrer le visage d'un membre, et garde une trace (`consent_given`, `consent_date`) en base.

## Sécurité / connexion
Au premier lancement de `app.py`, un écran demande de **créer un mot de passe administrateur** (stocké de façon sécurisée : sel aléatoire + hash PBKDF2, jamais en clair, dans `auth.json` à côté de `members.db`). Aux lancements suivants, ce mot de passe est demandé avant d'accéder à l'application (5 tentatives max). Ça évite que n'importe qui allumant le PC puisse consulter la liste des membres et leurs visages.

## Gestion des membres et historique
- **Suppression d'un membre** (onglet Membres) : retire définitivement la personne et son visage enregistré de la base — utile en cas de départ, ou pour répondre à une demande de suppression de données (droit à l'effacement, loi n° 18-07).
- **Historique des accès** (onglet Historique) : chaque tentative de reconnaissance (autorisée, refusée, abonnement expiré) est journalisée avec date/heure. Exportable en CSV (bouton "Exporter en CSV") pour un suivi de présence ou une vérification a posteriori.

## Anti-spoofing (détection de clignement)
Pour éviter qu'une simple photo (imprimée ou affichée sur un écran) suffise à ouvrir l'accès, l'app exige un **clignement des yeux** avant d'accorder l'accès à une personne reconnue et à jour de son abonnement.

- Implémenté dans `liveness.py`, réutilisant uniquement les 68 points de repère du visage déjà fournis par `face_recognition`/`dlib` (pas de dépendance supplémentaire type MediaPipe).
- Calcul du ratio EAR (*Eye Aspect Ratio*) sur chaque œil : il chute nettement le temps d'un clignement. Dès qu'un clignement est détecté, le badge passe de « CLIGNEZ DES YEUX POUR VÉRIFIER (Xs) » à « ACCÈS AUTORISÉ », et reste autorisé tant que la personne reste face caméra en continu.
- Si la personne quitte le champ de la caméra puis revient, un nouveau clignement est redemandé.
- Actif dans `app.py` (onglet Reconnaissance) et dans `main.py`. Peut être désactivé en mettant `REQUIRE_BLINK = False` en haut du fichier concerné.

## Pistes d'amélioration
- Interface admin web pour gérer les membres/abonnements sans passer par `register.py`.
- Historique des accès (logs horodatés + export CSV).
- Renouvellement d'abonnement via `update_subscription()` dans `db.py`.
