# Statistiques : première version et draft des prochains indicateurs

## Accès et organisation

Entrée **Statistiques** dans la navigation des administrateurs. Quatre vues partagent les mêmes filtres :

1. **Vue d’ensemble** : volume, connexion, durée moyenne, appels manqués, évolution quotidienne entrants/sortants, résultats, heatmap et contribution des utilisateurs.
2. **Appels** : heatmap et journal paginé, tri par date ou durée, détail d’un appel et export CSV de toute la sélection.
3. **Équipes & utilisateurs** : regroupement par utilisateur, groupe de membres d’une file ou ligne ; volumes, sens, taux de connexion, durées moyenne et cumulée.
4. **IVR & vocal** : appels avec parcours vocal, connexion après routage, messages déposés, durée moyenne des messages et demandes de transfert. Les mesures non disponibles sont présentées comme « À instrumenter ».

« SV » est interprété provisoirement comme serveur vocal / messagerie vocale, à confirmer avec le porteur du produit.

## Filtres implémentés

- Période libre de 1 à 90 jours ; raccourcis aujourd’hui, 7, 30 ou 90 jours.
- Comparaison avec le même nombre de jours calendaires précédents, avec les mêmes filtres. La journée en cours est partielle.
- Utilisateurs, équipes et lignes en sélection multiple. Les dimensions se croisent avec un ET, les valeurs d’une même dimension avec un OU.
- Entrants / sortants, résultat, type de parcours, durée minimale / maximale en secondes.
- Jours de semaine, heures de début / fin, fuseau horaire et recherche par numéro distant.
- Pastilles de filtres supprimables et remise à zéro.
- Heatmap 7 × 24 : volume, manqués, durée moyenne ou taux de connexion. Cliquer une cellule applique jour et heure au journal.

Les équipes sont les **membres actuels des files**, pas les files effectivement traversées. Elles peuvent se recouper. Aucune appartenance historique n’est inventée. Les agents TaskRouter et renvois externes qui ne disposent pas de branche liée à un appareil identifiable restent non attribués. Les anciens utilisateurs figurent dans l’export par identifiant si leur nom n’est plus disponible.

## Définitions des KPIs

| Indicateur | Calcul / limite |
| --- | --- |
| Volume | Un appel logique compte une fois, indépendamment de ses branches de sonnerie. Date de création dans le fuseau choisi. |
| Connexion confirmée | Branche enfant ayant répondu, ou résultat `queue_bridged` / `forward_completed`. Le décroché de la branche racine entrante, potentiellement automatique, ne suffit pas. |
| Taux de connexion | Appels terminés avec connexion confirmée / appels terminés. Les appels en cours sont exclus du dénominateur. Il ne s’agit pas encore d’un niveau de service. |
| Durée moyenne / totale | Durées de conversation connues pour les connexions confirmées. Les valeurs nulles sont exclues, les zéros mesurés sont conservés. Couverture indiquée en nombre d’appels. |
| Manqués | Appels sans connexion confirmée avec statut `missed` ou `canceled`. Les échecs et messages vocaux sont distingués. |
| Parcours vocal | Présence d’un état IVR classique ou avancé sur l’appel. Un parcours avancé peut router sans afficher de menu. |
| Messages vocaux | Enregistrements présents dans `voice_voicemails`, rattachés aux appels de la sélection. Ce n’est pas le nombre de passages vers la messagerie. |
| Transferts | Somme des générations de transfert (`epoch`) enregistrées. Une demande n’est pas une réussite confirmée. |
| Comparaison | Variation relative pour les volumes / durées, différence en points pour les taux. Une base nulle ou inconnue affiche « — ». |

Un appel terminé sans preuve de connexion n’est pas requalifié automatiquement en abandon. La réussite technique de Twilio ne prouve pas qu’un humain a répondu. Les regroupements utilisateurs ne sont pas nécessairement additionnables lorsqu’un appel implique plusieurs agents.

## Suite proposée : instrumentation IVR et supervision

Priorité 1 : journal append-only des étapes d’appel, indépendant de la configuration courante. Chaque événement doit contenir organisation, appel, version du parcours, file, agent, horodatage fournisseur, horodatage de réception et identifiant d’idempotence. Conserver l’équipe / la file au moment de l’événement.

| Événements à conserver | KPIs débloqués |
| --- | --- |
| Entrée / sortie de menu, choix valide, saisie invalide, timeout | Répartition par branche, durée de navigation, répétitions, absence de choix et abandon dans l’IVR. |
| Entrée / sortie de file et motif, agent connecté, fin de conversation | Attente moyenne et P90, niveau de service à 20 / 30 / 60 s, abandons et durée avant abandon, débordements. |
| Transfert demandé, exécuté, échoué | Taux de transfert et réussite, passages entre équipes. |
| Message enregistré, première écoute, traitement, rappel associé | Stock non traité, délai de première écoute, rappels et délai de traitement. |
| Disponibilité / pause / occupation, travail après appel | Taux d’occupation et durée moyenne de traitement, avec temps après appel distinct. |

Pour le niveau de service, décider explicitement si les abandons courts sont exclus ; publier le seuil et le dénominateur dans l’interface. Présenter le taux d’abandon parmi les entrées en file et séparer abandon dans le menu, pendant l’attente et après transfert. Un callback manquant doit rester une mesure inconnue.

Priorité 2 : vraie entité équipe avec historique, filtres par file traversée / branche / campagne / horaires d’ouverture, percentiles, comparaison des équipes et vues sauvegardées. Le taux de résolution au premier contact et la satisfaction nécessitent des données de qualification ou d’enquête supplémentaires.

## API et limites de cette version

`GET /v1/organizations/:orgId/statistics?from=<ISO>&to=<ISO>` : lecture seule, administrateur actif requis, contrôle supplémentaire via `admin_snapshot`, réponse `no-store`. Toutes les requêtes serveur sont limitées à l’organisation. Le client ne reçoit ni configuration IVR complète ni identifiants Twilio.

La plage serveur est limitée à 186 jours, pour inclure comparaison et marges de fuseau. Les appels et relations sont paginés par identifiant, y compris si PostgREST impose une taille de page inférieure à 500. Plus de 20 000 appels provoquent un refus explicite invitant à réduire la période ; aucun total partiel n’est affiché. En cas d’échec réseau, les anciens totaux sont masqués et l’utilisateur peut réessayer.

Les données sont lues à l’ouverture, au changement de période et à l’actualisation de l’espace. Ce n’est pas une supervision en direct. Cette première version calcule les agrégats dans le navigateur ; à plus grande échelle, prévoir des agrégats serveur et une API paginée pour le journal. Les mises à jour d’appels pendant une lecture ne constituent pas un snapshot transactionnel.

Aucune migration, publication d’IVR, écriture Twilio ou modification des appels existants n’est nécessaire. Aucun jeu de données fictif n’est chargé dans l’application. Les fixtures servent uniquement aux tests et à la vérification visuelle locale.

## Validation

- Tests du modèle : valeurs inconnues vs zéro, filtres croisés, changement d’heure, comparaison, correspondance heatmap/journal et protection du CSV contre l’interprétation de formules.
- Tests API : accès administrateur, portée d’organisation, période invalide, refus des données partielles, pagination et distinction entre accueil automatique / connexion.
- Builds API et Web, tests existants et vérification navigateur sur fixtures locales isolées.

Validation locale du 26 septembre 2026 : builds contrats/API/Web réussis ; **66 tests API et 34 tests Web réussis**. Vérification navigateur à 1440 px et 390 px : filtres, durée invalide, clic heatmap, regroupement équipe, export CSV, états vide/erreur et nouvelle tentative. Les captures de démonstration se trouvent dans `output/playwright/statistics-*.png`. Le runtime disponible est Node 26 ; le dépôt déclare Node 24, à revalider sur ce runtime avant livraison. Vite signale également la taille du bundle principal.

API et Web doivent être livrés ensemble. Le raccordement à une base hébergée et la recette sur appels réels restent à valider avant déploiement.
