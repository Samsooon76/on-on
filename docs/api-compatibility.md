# Compatibilité API et versions des clients

## Contrat actuel

- L'API publique est `/v1`; les clients Web et Mobile lisent leur version dans les réglages et l'API expose sa version sur `/health/live` et `/health/ready`.
- Aucune version minimale de client n'est imposée par le serveur aujourd'hui. Il n'existe pas encore de build mobile signé ou distribué dont il faudrait préserver l'accès.
- Tant qu'un client Web/Mobile utilisant `/v1` est distribué, les changements sont additifs : champs de réponse facultatifs, nouvelles routes ou nouvelles valeurs d'état que les clients existants peuvent ignorer. Ne pas retirer/renommer un champ, modifier le sens d'un statut ou changer les droits derrière une route existante.
- Les migrations suivent expand/migrate/contract : rendre le code compatible avant d'ajouter la dépendance au nouveau schéma, puis ne retirer une structure qu'après l'expiration de la période de support et la preuve qu'aucun client distribué ne l'utilise.

## Changement incompatible

1. Ajouter un nouveau contrat sous `/v2`; garder `/v1` opérationnel pendant la période de migration.
2. Publier le client qui utilise `/v2` et mesurer les versions adoptées avant de fixer une date de retrait.
3. Ne jamais supprimer `/v1` en même temps qu'un changement de base incompatible. Produire d'abord un état d'erreur explicite et documenté pour tout client encore présent.
4. N'ajouter un contrôle de version minimale qu'une fois une politique de support décidée et les versions distribuées observables. Le comportement attendu pour une version devenue obsolète sera alors un message de mise à jour, sans action d'appel/SMS partiellement exécutée.

Cette politique décrit les garanties applicables aux versions publiées; elle ne remplace pas les essais sur les anciens binaires réels. Voir [la matrice des plateformes](test-reports/platform-support-matrix.md) et [la procédure de retour arrière](runbooks/backup-and-restore.md).
