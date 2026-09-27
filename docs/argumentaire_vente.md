# FaceID — Contrôle d'accès par reconnaissance faciale
### Argumentaire de vente (à montrer aux gérants)

---

## Le problème que vous connaissez déjà

- Des membres qui rentrent alors que leur abonnement est expiré.
- Des cartes/badges perdus, oubliés, prêtés à d'autres personnes.
- Une personne à l'accueil qui doit vérifier manuellement chaque arrivée.

## La solution : une caméra qui fait le contrôle toute seule

**FaceID** reconnaît le visage de vos membres/employés et affiche instantanément :

| Situation | Résultat affiché |
|---|---|
| Membre reconnu, abonnement à jour | ✅ **ACCÈS AUTORISÉ** (porte peut s'ouvrir automatiquement) |
| Membre reconnu, abonnement expiré | 🟠 **ABONNEMENT EXPIRÉ** — à renouveler avant d'entrer |
| Personne non enregistrée | 🔴 **ACCÈS REFUSÉ** |

Et pour éviter qu'on triche avec une simple photo : le système demande à la personne de **cligner des yeux** avant de valider — une photo imprimée ou affichée sur un téléphone ne suffit pas.

## Pour qui c'est fait

- 🏋️ **Salles de sport / fitness club** — fini les abonnements expirés qui passent quand même.
- 🎮 **Salles de jeux (gaming, PS, cybercafé)** — accès reservé aux abonnés/membres.
- 🏢 **Espaces de coworking** — accès autonome, pas besoin d'un agent 24h/24.
- 🎓 **Écoles privées, instituts de langues, auto-écoles** — pointage automatique des inscrits.
- 🏘️ **Immeubles / résidences (syndics)** — remplace l'interphone/le badge pour le portail ou le hall.
- 🏭 **Petites entreprises, ateliers, bureaux** — pointage des employés, sans badgeuse à acheter.
- 🚗 **Parkings privés / piscines de complexes** — accès réservé aux abonnés.

## Pourquoi c'est intéressant pour vous (l'installateur / le vendeur)

- **Pas de matériel exotique** : un simple PC + une webcam suffisent (déjà présents dans la plupart des accueils).
- **Moins cher qu'un système importé** (empreinte digitale, badges RFID, caméras "intelligentes" propriétaires).
- **Installation locale, support local** — vous êtes sur place, contrairement aux solutions étrangères.
- **Base de fidélisation** : chaque client équipé devient une référence pour convaincre le suivant.

## Ce qui est inclus

- Logiciel avec interface simple à 3 écrans : **Membres**, **Enregistrer**, **Reconnaissance**.
- Gestion des abonnements (dates de fin, renouvellement en 2 clics).
- Anti-fraude par détection de clignement des yeux.
- Option : ouverture automatique d'une porte/gâche électrique via un petit boîtier Arduino (~2000-4000 DA de matériel).
- Formulaire de consentement fourni pour rester en règle avec la loi sur les données personnelles (voir `docs/conformite_donnees.md`).

## Modèle de tarification suggéré (à adapter)

- **Installation + configuration** : forfait unique (matériel du client : PC + webcam, ou fourni en option).
- **Maintenance / mises à jour** : petit abonnement mensuel ou par intervention.
- **Option porte automatique (Arduino + gâche)** : supplément matériel + installation.

*(Ajustez ces montants selon votre marché local — Alger/Oran/Constantine n'ont pas forcément les mêmes prix.)*

## Ce qu'il ne faut pas oublier de dire au client

> "Le visage de vos membres est une donnée personnelle sensible. On fait toujours signer un petit formulaire de consentement avant d'enregistrer quelqu'un — c'est fourni avec le logiciel, ça vous protège aussi en cas de contrôle."

---
*Document à adapter/personnaliser avec votre nom, logo et coordonnées avant de le présenter à un client.*
