# Face ID - Contrôle d'accès par abonnement

## Installation
```bash
pip install -r requirements.txt
```
Sur Windows, `dlib` (dépendance de `face_recognition`) demande souvent CMake + Visual Studio Build Tools.
Le plus simple : `pip install cmake` puis `pip install dlib`, ou utiliser un environnement conda avec `conda install -c conda-forge dlib`.

## Utilisation

### Interface unique (recommandé)
```bash
python app.py
```
Une fenêtre avec 3 onglets : **Membres** (liste + renouvellement), **Enregistrer** (webcam + nom + date), **Reconnaissance** (flux live avec statut d'accès). Tout est relié à la même base `members.db`.

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
