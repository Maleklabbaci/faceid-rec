# Conformité légale — Données biométriques (Algérie)

*Ce document est une aide pratique, pas un conseil juridique officiel. Pour un déploiement commercial sérieux, faites valider votre démarche par un juriste ou consultez directement l'ANPDP.*

## Pourquoi c'est important

Le visage d'une personne, une fois transformé en donnée numérique pour la reconnaissance faciale, est une **donnée personnelle biométrique** — une catégorie considérée comme **sensible** dans la plupart des législations, y compris en Algérie.

## Cadre légal en Algérie

- **Loi n° 18-07 du 10 juin 2018** relative à la protection des personnes physiques dans le traitement des données à caractère personnel.
- Elle impose notamment :
  - Le **consentement explicite** de la personne avant de traiter ses données sensibles (dont les données biométriques) ;
  - L'**information claire** de la personne sur l'usage qui sera fait de sa donnée ;
  - Des **mesures de sécurité** pour protéger les données stockées ;
  - Dans certains cas, une **déclaration ou autorisation préalable** auprès de l'**ANPDP** (Autorité Nationale de Protection des Données à caractère Personnel) avant de commencer le traitement.

## Checklist avant de déployer FaceID chez un client

- [ ] **Consentement signé** pour chaque personne enregistrée (utiliser `docs/formulaire_consentement.md`).
- [ ] **Information affichée** dans l'établissement (ex : affichette "Zone sous vidéo-reconnaissance, accès réservé aux personnes ayant donné leur consentement").
- [ ] **Se renseigner auprès de l'ANPDP** (ou d'un juriste local) si une déclaration/autorisation est nécessaire pour votre cas d'usage précis (salle de sport, entreprise, résidence...).
- [ ] **Sécuriser la base de données** (`members.db`) :
  - PC protégé par mot de passe, pas accessible à n'importe qui.
  - Sauvegardes faites de façon sécurisée (pas de copie qui traîne sur une clé USB non chiffrée).
  - Accès au logiciel réservé au personnel autorisé (gérant, responsable).
- [ ] **Procédure de suppression** : prévoir comment supprimer les données d'une personne qui le demande ou qui quitte l'établissement (aujourd'hui : suppression manuelle via la base ou une future fonctionnalité dédiée).
- [ ] **Ne pas réutiliser les visages à d'autres fins** (marketing, revente, partage avec un tiers) — uniquement le contrôle d'accès prévu.

## Ce qui a déjà été mis en place techniquement dans le logiciel

- Une case à cocher obligatoire dans l'écran "Enregistrer" (`app.py`) empêche d'ajouter un membre sans confirmer que le consentement a été recueilli.
- Chaque membre enregistré garde une trace (`consent_given`, `consent_date`) dans la base de données.
- Le script en ligne de commande `register.py` demande aussi une confirmation explicite avant tout enregistrement.

## Ce qui reste à la charge du gérant / installateur

- Faire réellement signer le formulaire papier (le logiciel ne peut pas vérifier qu'il a été signé, seulement qu'on l'a coché).
- Vérifier auprès de l'ANPDP si son cas nécessite une formalité préalable.
- Informer visiblement les personnes filmées/reconnues.
- Répondre aux demandes de suppression de données.

## Ressources

- Autorité Nationale de Protection des Données à caractère Personnel (ANPDP) — organisme algérien compétent pour ces questions.
- Loi n° 18-07 du 10 juin 2018 (Journal Officiel de la République Algérienne).
