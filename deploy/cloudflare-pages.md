# Mettre la plateforme en ligne sur Cloudflare Pages (gratuit, « push → en ligne »)

Cette édition tourne **entièrement chez Cloudflare**, sans serveur à gérer :

| Brique | Rôle | Où ça tourne |
|---|---|---|
| `site/` | Interface (accueil, connexion, espace entreprise, kiosque) | Cloudflare Pages (fichiers statiques) |
| `functions/api/[[route]].js` | API JSON (comptes, membres, journal, règles secteur) | Pages Functions (Workers) |
| Base **D1** `faceid` | Données de toutes les entreprises (isolées par `org_id`) | Cloudflare D1 (SQLite géré) |
| `site/vendor/face-api.js` + `site/models/` | **Reconnaissance faciale dans le navigateur** du kiosque | Le PC / la tablette à l'entrée |

Les images de la caméra ne quittent jamais l'appareil : le navigateur calcule une empreinte de
128 nombres (même réseau de neurones que l'application de bureau) et seule cette empreinte est
enregistrée. Le kiosque télécharge les empreintes de l'entreprise et compare localement ; seule la
décision (« membre n° 12 reconnu ») est envoyée à l'API, qui applique les règles (abonnement
expiré, un repas par jour, retard…) et tient le journal.

> Offre gratuite Cloudflare (ordre de grandeur) : 100 000 requêtes API / jour, D1 5 Go et
> 100 000 écritures / jour — largement suffisant pour plusieurs dizaines de clients.

---

## 1. Les 6 réglages à faire une seule fois (projet `saaspromax`)

Dans le tableau de bord Cloudflare → **Workers & Pages** → projet **`saaspromax`** :

1. **Settings → Builds & deployments → Build configuration → Edit**
   - *Framework preset* : `None`
   - *Build command* : **vide**
   - *Build output directory* : **`site`**
   - *Root directory* : `/` (laisser vide)
   - *Production branch* : **`main`**
2. **Créer la base** : menu de gauche **Storage & Databases → D1 SQL Database → Create** →
   nom **`faceid`** → Create. (Rien d'autre à faire : les tables sont créées automatiquement
   au premier appel de l'API ; `schema.sql` est fourni à titre de référence.)
3. **Lier la base au projet** : retour sur `saaspromax` → **Settings → Bindings → Add → D1 database**
   - *Variable name* : **`DB`** (exactement ces deux lettres, en majuscules)
   - *D1 database* : `faceid`
   - Faire la liaison pour **Production** *et* pour **Preview**.
   - Attention au piège classique : `DB` doit être une liaison **de type « D1 database »**, pas une
     *variable* ni un *secret* qui s'appellerait `DB`, et pas un KV/R2. Une variable texte `DB=faceid`
     donne une erreur `env.DB.prepare is not a function` au lieu de relier la base.
4. **Secret de hachage des mots de passe** : **Settings → Variables and Secrets → Add**
   - Type **Secret**, nom **`PEPPER`**, valeur : une longue chaîne aléatoire (30+ caractères,
     par ex. générée avec `openssl rand -base64 32` ou un gestionnaire de mots de passe).
   - Production *et* Preview. Ne changez plus cette valeur ensuite (sinon les mots de passe
     existants ne seront plus reconnus).
5. **Fusionner la PR #1 dans `main`** (GitHub → Pull requests → *Merge*). Pages déploie la
   branche `main` en production automatiquement à chaque push.
6. **Redéployer** si besoin : **Deployments → ⋯ → Retry deployment** (nécessaire après avoir
   changé le dossier de sortie ou les bindings).

Ensuite ouvrez **https://saaspromax.pages.dev** → *Essai gratuit* → créez votre espace.

Vérification rapide : `https://saaspromax.pages.dev/api/healthz` doit répondre
`{"status":"ok","db":true,"pepper":true}`.

- `{"status":"degraded","db":false,...}` → l'étape 3 est à refaire ; le champ `message` dit exactement
  quoi. Exemples rendus par la plateforme :
  - `"detail":"missing"` → aucune liaison `DB` (faire l'étape 3 puis l'étape 6).
  - `"detail":"wrong-type"` avec « ce n'est pas une base D1 (reçu : une variable texte / un namespace
    KV / un Durable Object) » → une variable **nommée** `DB` masque la liaison : la supprimer dans
    *Variables and Secrets*, recréer l'étape 3 en **type = D1 database**, puis redéployer. Ces deux cas
    renvoyaient avant un `500` muet (et `TypeError: env.DB.prepare is not a function` dans le journal
    d'appels / `wrangler tail`) sur `/api/signup` comme sur tout le reste.
- En ligne de commande, un redéploiement qui refigure la liaison :
  `npx wrangler pages deploy site --project-name saaspromax --d1 DB=faceid`
  (à faire depuis la branche déployée ; le dépôt passe par GitHub, donc l'étape 6 suffit en général).
- `"pepper":false` → l'étape 4 manque (la plateforme fonctionne quand même, avec un secret par
  défaut moins sûr).

### Pourquoi la première URL affichait `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`

Les URL de prévisualisation `xxxxxxxx.saaspromax.pages.dev` utilisent un certificat
« wildcard » émis quelques minutes **après** la création du projet : pendant ce délai, Chrome
affiche cette erreur. L'URL de production **`https://saaspromax.pages.dev`** est disponible
tout de suite. Si l'erreur persiste plus de 15 minutes sur la production : Cloudflare →
**SSL/TLS → Edge Certificates** et vérifier que le certificat universel est *Active*.

---

## 2. Nom de domaine (optionnel)

`saaspromax` → **Custom domains → Set up a custom domain** → `app.votre-domaine.dz`.
Si le domaine est déjà chez Cloudflare, l'enregistrement DNS est créé automatiquement et le
HTTPS est immédiat. Réglages conseillés sur le domaine : **Speed → Optimization → Rocket Loader :
Off** et **Scrape Shield → Email Address Obfuscation : Off** (ils injectent des scripts que la
politique de sécurité stricte de la plateforme bloque).

---

## 3. Côté kiosque (PC ou tablette à l'entrée)

- Navigateur **Chrome** ou **Edge** récent (voix féminine française gratuite « Google français »
  incluse ; sinon les annonces enregistrées sont utilisées).
- Premier lancement de la caméra : téléchargement unique du moteur facial (≈ 7 Mo), puis mis en
  cache un an. Analyse d'une image : 100 à 300 ms sur un PC courant (accélération WebGL).
- Autoriser la caméra pour `saaspromax.pages.dev` (icône cadenas → Caméra → Autoriser).
- Mode automatique : un visage reconnu = une annonce + une ligne au journal ; la même personne
  n'est pas réenregistrée pendant 60 s.

---

## 4. Travailler en local / mettre à jour

```bash
npm install                       # installe wrangler (outil Cloudflare)
npm run dev                       # http://localhost:8788 avec une base D1 locale
npm test                          # 17 tests de bout en bout de l'API (démarre un serveur local)
npm run test:ui                   # 18 tests « navigateur » : login, inscription, app, poste live, notifications
```

- Chaque `git push` sur `main` redéploie la production (≈ 30 s).
- Chaque push sur une autre branche crée une URL de prévisualisation `<hash>.saaspromax.pages.dev`
  reliée à la base D1 **Preview** (séparez bien les deux bindings à l'étape 3).
- Déploiement manuel sans GitHub : `npx wrangler login` puis `npm run deploy`.
- Sauvegarde de la base : `npx wrangler d1 export faceid --remote --output sauvegarde.sql`.

---

## 5. Limites connues de l'édition Cloudflare

- La reconnaissance dépend du navigateur du kiosque (pas de serveur GPU) : prévoir un PC avec une
  webcam correcte et un bon éclairage ; éviter les tablettes très anciennes.
- Mots de passe : PBKDF2 (8 000 itérations) + HMAC avec le secret `PEPPER`, dimensionné pour la
  limite CPU de 10 ms de l'offre gratuite. Sur l'offre Workers Paid (5 $/mois) ce chiffre peut
  être relevé.
- Pas encore de paiement en ligne, de réinitialisation de mot de passe ni de multi-administrateur
  (voir la feuille de route du README).

L'édition auto-hébergée (Flask + dlib + tunnel Cloudflare, dossier `web/`) reste disponible pour
les clients qui veulent leurs données sur leur propre serveur : voir `deploy/cloudflare.md`.
