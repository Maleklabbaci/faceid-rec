# Héberger FaceID Platform avec Cloudflare

## Pourquoi pas Workers / Pages ?

Cloudflare Workers et Pages exécutent du JavaScript/WASM (et un Python limité, sans bibliothèques natives). Le moteur facial (`dlib`, C++ natif, ~100 Mo de modèles) ne peut pas y tourner. **Cloudflare Containers** peut l'exécuter mais coûte 33 à 58 $/mois pour un conteneur toujours allumé, sans disque persistant, et nécessite le plan Workers Paid : à réserver pour plus tard.

**La solution : Cloudflare Tunnel (gratuit).** L'application tourne sur une machine à toi (PC Windows de la salle, mini-PC, ou VPS à ~5 €/mois) et `cloudflared` la relie au réseau Cloudflare. Tu obtiens :

- une URL HTTPS sur ton domaine (`https://app.tondomaine.com`) — indispensable pour la caméra du navigateur ;
- certificat TLS, protection DDoS et pare-feu Cloudflare, sans ouvrir aucun port sur ta box ;
- rien à payer de plus que le domaine.

```
Navigateur / téléphone ──HTTPS──► Cloudflare ──tunnel chiffré──► cloudflared ──► app:5000 (ta machine)
```

---

## Option A — VPS ou PC Linux avec Docker (recommandé pour la production)

Prérequis : Docker + Docker Compose, un domaine ajouté dans Cloudflare.

1. **Créer le tunnel** : Cloudflare Dashboard → **Zero Trust** → **Networks** → **Tunnels** → *Create a tunnel* → type **Cloudflared** → nom `faceid` → copie le **token** (commence par `eyJ…`).
2. **Hostname public** (onglet *Public Hostname* du tunnel) : sous-domaine `app`, domaine `tondomaine.com`, type **HTTP**, URL **`app:5000`** (c'est le nom du service Docker).
3. Sur la machine :
   ```bash
   git clone https://github.com/Maleklabbaci/faceid-rec.git && cd faceid-rec
   cp .env.example .env
   python3 -c "import secrets; print(secrets.token_hex(32))"   # → colle le résultat dans SECRET_KEY
   nano .env                                                    # SECRET_KEY + CLOUDFLARE_TUNNEL_TOKEN
   docker compose up -d --build
   docker compose logs -f tunnel                                # attendre "Registered tunnel connection"
   ```
4. Ouvre `https://app.tondomaine.com` → la plateforme est en ligne, caméra incluse.

Données : base SQLite et clé de session dans le volume Docker `faceid-data` (`docker compose down` ne les supprime pas). Sauvegarde : `docker run --rm -v faceid-rec_faceid-data:/data -v $PWD:/backup alpine tar czf /backup/faceid-backup.tgz /data`.

Mise à jour : `git pull && docker compose up -d --build`.

Machine minimale : 1 vCPU, 2 Go de RAM (chaque worker gunicorn charge le moteur facial, ~300 Mo ; `WEB_CONCURRENCY=1` sur 1 Go).

---

## Option B — PC Windows de la salle, sans Docker

Pratique pour démarrer : le PC qui sert de kiosque héberge aussi la plateforme.

1. Installer [Python 3.11+](https://python.org) (cocher **Add to PATH**) et [cloudflared pour Windows](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. Dans le dossier du projet (PowerShell) :
   ```powershell
   py -m venv .venv ; .venv\Scripts\Activate.ps1
   pip install -r requirements-web.txt dlib-bin numpy
   pip install --no-deps face_recognition face_recognition_models
   $env:SECRET_KEY = (python -c "import secrets; print(secrets.token_hex(32))")
   $env:WEB_DATABASE = "C:\FaceID\web.db" ; $env:TRUST_PROXY = "1" ; $env:PRELOAD_FACE = "1"
   waitress-serve --listen=127.0.0.1:5000 web.wsgi:app
   ```
   (gunicorn ne fonctionne pas sous Windows ; `waitress` est inclus dans `requirements-web.txt`.)
3. Créer le tunnel comme en option A, mais avec l'URL **`localhost:5000`**, puis installer cloudflared comme service Windows (démarre tout seul avec le PC) :
   ```powershell
   cloudflared service install <TOKEN>
   ```
4. Pour que l'application démarre aussi avec Windows : Planificateur de tâches → *À l'ouverture de session* → programme `C:\...\faceid-rec\.venv\Scripts\waitress-serve.exe`, arguments `--listen=127.0.0.1:5000 web.wsgi:app`, démarrer dans `C:\...\faceid-rec`, et définir `SECRET_KEY`/`WEB_DATABASE`/`TRUST_PROXY`/`PRELOAD_FACE` comme variables d'environnement système (`setx`).

Note : `SECRET_KEY` doit rester **identique** d'un démarrage à l'autre, sinon tous les utilisateurs sont déconnectés.

---

## Test express sans compte ni domaine (5 minutes)

Pour montrer la plateforme à quelqu'un tout de suite, `cloudflared` sait créer une URL temporaire `https://xxxx.trycloudflare.com` :

```bash
# terminal 1 : l'application (Linux/macOS)
COOKIE_SECURE=1 PRELOAD_FACE=1 TRUST_PROXY=1 gunicorn -w 1 --preload -b 127.0.0.1:5000 web.wsgi:app
# terminal 2 : le tunnel
cloudflared tunnel --url http://localhost:5000
```
L'URL s'affiche dans le terminal 2. Elle change à chaque lancement et n'est pas faite pour la production, mais la caméra et la voix fonctionnent (HTTPS).

---

## Réglages Cloudflare à vérifier

| Réglage | Valeur | Pourquoi |
|---|---|---|
| **Speed → Optimization → Rocket Loader** | **Off** (ou règle de configuration sur `app.tondomaine.com`) | Injecte un script inline bloqué par la politique de sécurité (CSP) de l'app → casserait la caméra/voix |
| **Scrape Shield → Email Address Obfuscation** | Off pour ce hostname | Même raison (script inline) |
| SSL/TLS | laisser par défaut | Le tunnel est chiffré de bout en bout ; aucun certificat à installer |
| Caching | laisser par défaut | L'app envoie `Cache-Control: no-store` sur les pages privées |
| **Zero Trust → Access** (optionnel) | Application `app.tondomaine.com`, politique « emails autorisés » | Deuxième verrou devant l'espace admin ; le kiosque garde une session Access jusqu'à 1 mois |

---

## Variables d'environnement de l'application

| Variable | Rôle | Production |
|---|---|---|
| `SECRET_KEY` | Signature des sessions | **obligatoire**, 64 caractères hex, stable |
| `WEB_DATABASE` | Fichier SQLite (la clé de session générée est stockée à côté) | sur un disque persistant |
| `TRUST_PROXY` | `1` derrière Cloudflare/Nginx : vraie IP client (`CF-Connecting-IP`) pour la limitation de tentatives, schéma HTTPS | `1` |
| `PRELOAD_FACE` | `1` : charge le moteur facial au démarrage (partagé entre workers gunicorn) | `1` |
| `COOKIE_SECURE` | `0` ou `1` pour forcer (inutile : par défaut le cookie suit le schéma de la requête) | ne pas définir |
| `EMBED_PREVIEW` | `1` seulement pour l'aperçu intégré dans une iframe | ne pas définir |
| `WEB_CONCURRENCY` | Nombre de workers gunicorn | 2 (1 si 1 Go de RAM) |

Supervision : `GET /healthz` renvoie `{"status":"ok","face_engine":true}` (utilisé par le `HEALTHCHECK` Docker, utilisable par UptimeRobot ou Cloudflare Health Checks).

## Et après ?

- Au-delà de quelques dizaines d'entreprises clientes : passer la base de SQLite à PostgreSQL et mettre la limitation de tentatives dans Redis (elle est aujourd'hui par processus).
- Boîtier porte/tourniquet : un ESP32 sur site interrogera la plateforme ; le tunnel n'empêche rien.
