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
- [x] **Procédure de suppression** : disponible directement dans l'onglet Membres (bouton "Supprimer le membre") — supprime la donnée biométrique et la photo associée.
- [ ] **Ne pas réutiliser les visages à d'autres fins** (marketing, revente, partage avec un tiers) — uniquement le contrôle d'accès prévu.

## Ce qui a déjà été mis en place techniquement dans le logiciel

- **Consentement implicite et automatique** : se présenter volontairement devant la caméra pour se faire enregistrer (écran "Enregistrer" de `app.py`, ou `register.py`) est considéré comme une acceptation — il n'y a plus de case à cocher qui bloque le flux, l'enregistrement est immédiat.
- Chaque membre enregistré garde quand même une trace (`consent_given=True`, `consent_date`) dans la base de données, horodatée automatiquement.
- Cette approche est plus rapide/fluide pour l'opérateur, mais elle repose sur le fait que la personne comprend ce qui se passe : c'est pour ça que l'affichage d'une information visible à l'accueil (voir checklist ci-dessus) reste important.
- **Droit à l'effacement** : un bouton "Supprimer le membre" (onglet Membres) retire définitivement la donnée biométrique et la photo associée.
- **Accès protégé par mot de passe** (`auth.py`) : seule une personne connaissant le mot de passe administrateur peut ouvrir l'application et consulter les visages/membres enregistrés.
- **Historique des accès** (onglet Historique, export CSV) : permet de répondre à une demande de traçabilité ("qui est entré, quand") sans avoir à consulter les enregistrements vidéo.

## Ce qui reste à la charge du gérant / installateur

- **Informer visiblement** les personnes avant qu'elles ne se présentent devant la caméra (affichette à l'accueil, explication orale) — puisque le logiciel ne demande plus de confirmation explicite, c'est cette information préalable qui rend le consentement valable.
- Pour les cas sensibles (mineurs, environnements réglementés), garder `docs/formulaire_consentement.md` en réserve et le faire signer manuellement si vous préférez une preuve papier.
- Vérifier auprès de l'ANPDP si son cas nécessite une formalité préalable.
- Répondre aux demandes de suppression de données.

## Ressources

- Autorité Nationale de Protection des Données à caractère Personnel (ANPDP) — organisme algérien compétent pour ces questions.
- Loi n° 18-07 du 10 juin 2018 (Journal Officiel de la République Algérienne).
