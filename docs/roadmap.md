# Prochaines étapes triées par valeur et risque

Le projet reste un prototype non publié. Les rangs tiennent compte du risque de dépense, d'exposition ou d'une fausse déclaration de support.

## P0 — Débloquer une recette vocale sûre

| Ordre | Travail | Valeur | Risque si reporté | Dépend de |
|---:|---|---|---|---|
| 1 | Révoquer les anciens secrets Twilio repérés dans le document de plan et en émettre de nouveaux; les stocker uniquement dans l'environnement serveur | Très forte | Très élevé : accès fournisseur potentiellement exposé | Propriétaire du compte Twilio |
| 2 | Choisir les pays/destinataires et un budget de recette; vérifier les capacités Voix/SMS de la ligne et mettre en place les alertes fournisseur | Très forte | Très élevé : appel/SMS facturé ou non autorisé | Compte Twilio, responsables de test |
| 3 | Créer un compte de test et affecter une ligne; fournir une URL API HTTPS stable puis régler le webhook Twilio canonique | Très forte | Élevé : aucun flux de bout en bout vérifiable | Administrateur Supabase et Twilio, hébergement |
| 4 | Exécuter la recette Web : permission microphone, appel court, callbacks, durée/historique, fermeture/reprise d'onglet et vérification du coût | Très forte | Élevé : comportement fournisseur encore inconnu | Étapes 1–3, navigateur et téléphone externe |

## P1 — Valider Mobile et les invariants

| Travail | Valeur | Risque si reporté | Dépend de |
|---|---|---|---|
| Configurer credentials PushKit/APNs et FCM, produire des builds internes signés, tester veille, écran verrouillé, annulation, Bluetooth et interruptions | Forte | Élevé : appels mobiles entrants non garantis | Apple Developer, Firebase, Mac/Xcode, Android SDK/JDK, vrais appareils |
| Exécuter les tests de permissions, rejouabilité, callbacks réordonnés, reprise et délimitation des organisations; utiliser une base distante isolée pour les cas multi-tenant | Très forte | Élevé : régression d'autorisation ou de concurrence | Utilisateurs et données de test, environnement distant isolé |
| Tester clavier, contraste et lecteur d'écran sur le Web et les plateformes annoncées | Forte | Moyen | Navigateur, appareils et lecteur d'écran |
| Configurer les alertes de consommation Twilio et Railway et vérifier leurs seuils avec un budget convenu | Forte | Très élevé | Comptes fournisseur et seuils validés |

## P2 — Rendre la démo autonome

- Rétablir l'accès GitHub au dépôt confirmé `Samsooon76/on-on`, puis relier son branchement à Railway et choisir le projet cible avant d'y créer un service.
- Déployer API et worker, configurer les secrets de l'environnement de démo et vérifier santé, migrations additives et procédure de restauration.
- Inviter les utilisateurs de démonstration, créer les affectations nécessaires, puis rejouer le smoke test sans tunnel local.

## Après J3/J4 — Distribution et fonctions avancées

- Démarrer Electron et l'extension Chrome seulement après recette Web/Mobile stable et démo hébergée.
- Choisir leurs contrats, permissions, scénarios et comportement de mise à jour dans `docs/decisions/` avant distribution.
- Laisser enregistrement, transcription, résumé et export désactivés jusqu'aux décisions de consentement, d'accès, de budget et de conservation/suppression.

## Décisions métier encore requises

- Durée de conservation et procédure de suppression des données personnelles.
- Pays, destinataires, comptes testeurs, plafond de dépense et responsable de surveillance.
- Accès GitHub authentifié et écriture dans le dépôt source `Samsooon76/on-on` (DNS GitHub indisponible et `.git` local en lecture seule dans l'environnement actuel).
