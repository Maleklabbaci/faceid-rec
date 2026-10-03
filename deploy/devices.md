# Relier des appareils à l'espace (téléphone, tablette, PC, borne, caméra)

L'espace d'une entreprise n'est pas un seul poste : il peut y avoir un kiosque à chaque entrée.
Chaque appareil est **relié par un code**, nominatif, daté et **révocable en un clic**.

```
Espace entreprise → onglet « Appareils reliés »  →  génère un code (6 caractères, 10 minutes)
                        │
                        ├─ QR à scanner            →  /kiosk?pair=CODE
                        ├─ lien à envoyer          →  /kiosk?pair=CODE
                        └─ code à taper            →  /kiosk
                                                    ↓
                              l'appareil devient un kiosque : il reconnaît et journalise
```

## Ce qu'un appareil relié peut faire — et pas davantage

| Il peut | Il ne peut pas |
|---|---|
| `GET /api/device/state` — son nom, l'entreprise, les règles du secteur, les compteurs du jour, les derniers passages | Voir la liste des membres, leurs emails, leurs abonnements (`GET /api/state`) |
| `GET /api/device/descriptors` — les empreintes faciales **consenties** de son entreprise, pour comparer dans le navigateur | Modifier un membre, renouveler un abonnement, effacer une fiche |
| `POST /api/device/recognized` — journaliser un visage reconnu | Changer les réglages de l'espace (fuseau, heure de début, secteur) |
| `POST /api/device/entry` — valider le passage d'une personne désignée | Lister ou révoquer d'autres appareils |
| `POST /api/device/unpair` — oublier cet écran | Exporter le journal, gérer les codes d'autres appareils |

C'est le contrat vérifié par `tests/cloudflare.test.mjs` (« un appareil lié fait le kiosque, rien
d'autre ») : un jeton d'appareil ne traverse aucune route d'administration. Le serveur applique les
mêmes règles qu'à un humain — abonnement expiré refusé, un seul repas par jour, doublon de moins
d'une minute ignoré — donc un kiosque hors ligne ne peut pas « forcer » un passage.

## Comment l'appareil s'authentifie

À l'appairage, le serveur crée la ligne `devices` et renvoie **un jeton de 32 octets** (43
caractères, encodé en base64url) :

- **dans le navigateur** (téléphone, tablette, PC) : le jeton est posé dans un cookie `did`,
  `HttpOnly`, `SameSite=Lax`, `Secure` seulement quand le navigateur l'accepte (donc aussi sur
  `http://192.168.1.20:8788` d'un poste d'accueil en local), valable 365 jours ;
- **ailleurs** (relais, boîtier, automates) : en en-tête `Authorization: Bearer <jeton>`.

En base, seul un **SHA-256 du jeton** est stocké (`devices.token_hash`) : une sauvegarde de la base
ne donne aucun jeton réutilisable. Révoquer l'appareil écrit `revoked_at` — le jeton cesse de
résoudre **à la requête suivante**, sur tous les écrans de cet appareil.

Le jeton n'est affiché **qu'une fois**, à l'appairage (réponse de `POST /api/pair`). Perdu ?
Révoquez l'appareil et générez un nouveau code : c'est plus court que de le retrouver.

## Le code d'appairage

- 6 caractères pris dans `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — ni I, ni O, ni 0, ni 1, pour être
  dicté au téléphone sans erreur ;
- **valable 10 minutes**, et **à usage unique** (la ligne est supprimée à la première utilisation) ;
- 5 codes maximum en attente par entreprise, et 8 tentatives maximum par code ;
- la route publique `POST /api/pair` est **limitée à 15 tentatives par adresse IP et par
  5 minutes** : deviner un code (1,07 milliard de combinaisons) n'est pas une voie d'attaque
  réaliste, et un navigateur d'un autre site est refusé (`Sec-Fetch-Site`) ; une machine sans
  en-tête de navigateur (le relais d'une caméra) est acceptée, puisqu'aucun cookie n'est en jeu.

Dans l'interface, l'écran « Appareils reliés » affiche le code en grandes cases, **le QR à scanner**,
le lien complet à copier, le compte à rebours en direct, l'impression de la fiche, et la liste des
codes encore en attente (annulables).

## Kiosque : `/kiosk`

`site/kiosk.html` + `site/assets/kiosk.js`. Page autonome, pensée pour être lue à deux mètres :

- le lien partagé (`/kiosk?pair=CODE`) **relie l'appareil sans rien taper**, et le code est effacé de
  l'adresse (il ne reste pas dans l'historique, ni lisible par-dessus une épaule) ;
- sinon, le code se tape, en minuscules et avec des espaces : il est normalisé ;
- caméra + moteur facial dans ce navigateur, comme dans l'espace entreprise ; le mode automatique,
  une fois accepté, se réactive tout seul au rechargement (mémoire locale de l'appareil) ;
- la voix annonce le résultat (synthèse vocale française du navigateur, clips enregistrés en secours) ;
- « Quitter ce kiosque » oublie l'appareil **sur cet écran** (cookie effacé côté navigateur) sans
  révoquer la ligne `devices` : c'est l'administrateur qui décide de révoquer.

Aucune image de caméra ne quitte l'appareil : seules l'empreinte 128 nombres et la décision
(`member_id` + distance) circulent.

## Caméra réseau, boîtier, RTSP : le relais sur site

**Contrainte physique à dire aux clients :** une page web ne sait pas lire un flux RTSP, et la
plupart des caméras refusent les requêtes venues d'un autre site (pas d'`Access-Control-Allow-Origin`)
et se parlent en HTTP simple derrière un NAT. On ne « branche » donc pas une caméra IP sur le
navigateur : on branche un **petit relais sur place** qui, lui, sait lire le flux.

`tools/kiosk-relay.py` (Raspberry Pi, mini-PC, NAS — mêmes dépendances que l'app de bureau :
`opencv-python`, `numpy`, `face_recognition`) :

```bash
# 1. relier le boîtier : le code s'appaire une fois, le jeton est écrit dans ~/.faceid-device (600)
python3 tools/kiosk-relay.py --base https://monsite.pages.dev --code ABK7QD

# 2. webcam USB
python3 tools/kiosk-relay.py --source usb --interval 0.4

# 3. caméra IP : instantané HTTP (marche avec presque tout), ou flux RTSP si OpenCV le négocie
python3 tools/kiosk-relay.py --source http://192.168.1.44/snapshot.jpg --user cam --pass secret
python3 tools/kiosk-relay.py --source rtsp://cam:pass@192.168.1.44:554/Streaming/Channels/101

# 4. ouvrir la gâche quand le serveur autorise (et seulement quand il autorise)
python3 tools/kiosk-relay.py --on-granted "curl -s http://192.168.1.50/relay?open=1"
```

Le relais **ne décide rien** : il télécharge les empreintes consenties de son entreprise, mesure la
distance, et envoie `POST /api/device/recognized`. C'est l'API qui répond « accès autorisé »,
« abonnement expiré » ou « déjà enregistré aujourd'hui ». Si le réseau tombe, la porte ne s'ouvre pas
— choix assumé pour un contrôle d'accès commercial (on peut le discuter pour une gâche de secours).

En service (systemd) :

```ini
# /etc/systemd/system/faceid-relay.service
[Unit]
Description=Relais kiosque FaceID (camera entree)
After=network-online.target

[Service]
Environment=FACEID_BASE=https://monsite.pages.dev
Environment=FACEID_TOKEN=…          # ou le fichier ~/.faceid-device
ExecStart=/usr/bin/python3 /opt/faceid/tools/kiosk-relay.py --source http://192.168.1.44/snapshot.jpg --interval 0.4
Restart=always
User=faceid

[Install]
WantedBy=multi-user.target
```

Code de sortie : 2 = usage (code mal formé, jeton absent, source injoignable), 3 = appairage refusé,
4 = jeton révoqué ou expiré. `journalctl -u faceid-relay` affiche la même phrase que le kiosque.

## Déploiement : ce que ces appareils exigent côté projet

- **rien de plus** que le déploiement habituel : les tables `pairings` et `devices` et la colonne
  `entries.device_id` sont ajoutées automatiquement au premier appel (migrations additives — voir
  `deploy/cloudflare-pages.md` pour la liaison D1).
- Les en-têtes de `site/_headers` suffisent : `script-src 'self'` (le QR est un fichier local,
  `site/vendor/qr.js` — aucun CDN), `camera=(self)` pour la caméra, `frame-ancestors 'self'`.
- **HTTPS** pour tout ce qui sort du LAN : un navigateur ne donne la caméra qu'en contexte sécurisé.
  En local, `http://192.168.x.x:8788` fonctionne (c'est le cas du poste d'accueil derrière la box).
- `robots` : `/kiosk` est marqué `noindex` ; si vous voulez le retirer de Google complètement,
  ajoutez une règle dans `site/_headers` ou un `robots.txt`.

## Vérifier que ça tient (tests)

```bash
npm test                    # cycle complet : code, expiration, usage unique, droits du kiosque,
                            # isolement entre entreprises, révocation, budget de devinette
npm run test:kiosk          # 10 écrans rejoués en DOM : lien QR qui relie tout seul, code tapé,
                            # code faux expliqué, reconnaissance + journal, sortie du kiosque,
                            # cases du code, QR dessiné, compte à rebours, renommage, révocation
python3 -m pytest -q tests/test_relay.py   # le relais : jeton 600, en-têtes, messages d'erreur
```

## Le poste doit tourner sans personne : caméra toujours autorisée, mode automatique toujours actif

C'est le contrat de `site/kiosk.html` (et du poste live de l'espace, `#access`) : personne n'appuie
sur « Activer la caméra », et rien ne s'éteint si quelqu'un touche à un bouton.

Ce que le poste fait déjà, seul :

1. **ouverture automatique** de la caméra dès la page chargée (et à chaque retour d'onglet ou de
   veille), sans attendre un clic ;
2. **mode automatique activé par défaut** et mémorisé : la case n'est jamais décochée par le poste
   lui-même, et un `rec-auto` décoché à la main est réarmé par le veilleur ;
3. **backoff** sur un refus : `NotAllowedError` / `NotReadableError` / `NotFoundError` → la raison est
   écrite sur l'image, un nouvel essai est programmé (1,2 s → 2,4 s → 4,8 s → 9,6 s → 20 s maximum),
   et une fiche « caméra » l'accompagne — une seule fois, pas une pile ;
4. **surveillance du matériel** : une `MediaStreamTrack` qui meurt (câble débranché, caméra reprise
   par une autre application) déclenche une réouverture 1,5 s plus tard ; un veilleur toutes les
   10 s vérifie que l'image coule vraiment (`videoWidth`, `readyState`, `paused`) et rallume ;
5. **pause = une minute** : le bouton « Mettre en pause » arrête le flux, annonce la reprise, et la
   programmation tient même si la page est rechargée pendant la minute ;
6. **écran qui reste allumé** : `navigator.wakeLock` est demandé (et redemandé au retour d'onglet) —
   une borne endormie ne reconnaît plus personne, c'est le premier incident réel de ce produit ;
7. **journalisation locale** : si le réseau tombe, le poste continue de mesurer les visages et le
   kiosque le dit une fois par minute, sans inonder l'écran.

Pour qu'aucun humain n'ait jamais à cliquer « Autoriser la caméra » :

```bash
# Chromium / Edge / Chrome OS — borne en mode kiosque, caméra et son préaccordés
chromium --kiosk --autoplay-policy=no-user-gesture-required \
         --use-fake-ui-for-media-stream \
         --user-data-dir=/var/lib/faceid-kiosk \
         --disable-session-crashed-bubble --no-first-run \
         https://monsite.pages.dev/kiosk
```

- `--use-fake-ui-for-media-stream` accorde la caméra sans demander (à ne mettre que sur la borne de
  l'entrée : c'est un lâcher-prise de permission, pas un réglage de navigation ordinaire) ;
- `--autoplay-policy=no-user-gesture-required` laisse la voix et les sons sortir sans premier clic,
  sinon la borne est muette jusqu'à ce que quelqu'un la touche ;
- `--user-data-dir` isolé garde la permission et le jeton d'appareil (`localStorage`) entre les
  redémarrages, et `--kiosk` enlève barre d'adresse et geste de fermeture ;
- pas de `--use-fake-device-for-media-stream` en production : c'est une caméra fictive, utilisée par
  les tests, pas par l'entrée du bâtiment.

Firefox : accorder une fois la caméra (les permissions sont mémorisées par origine), puis régler
`permissions.memory_only = false` et `media.autoplay.blocking_policy = 0`. Sur téléphone, « Ajouter à
l'écran d'accueil » + autoriser la caméra une fois + écran toujours allumé ; le jeton est dans
`localStorage`, la page `/kiosk` n'est jamais mise en cache, donc une révocabilité est immédiate.

Côté serveur, rien de nouveau n'est nécessaire : la `Permissions-Policy` de `site/_headers` ouvre
déjà `camera=(self)`, et l'option `--auto-accept` du navigateur ne change aucun réglage Cloudflare.

