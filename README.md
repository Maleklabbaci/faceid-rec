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

## Pistes d'amélioration
- Anti-spoofing (détection de clignement via MediaPipe) pour éviter le déverrouillage avec une photo.
- Interface admin web pour gérer les membres/abonnements sans passer par `register.py`.
- Renouvellement d'abonnement via `update_subscription()` dans `db.py`.
