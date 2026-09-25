# Décision 005 — Persistance des réconciliations

- Date : 2026-09-25
- Statut : stockage relationnel hébergé retenu pour le prototype; crash tests et montée en charge à valider
- Projet : Supabase hébergé `onoffv2` uniquement.

## Modèle retenu

- Les messages SMS à rapprocher sont référencés par `message_reconciliation_tasks.message_id`. Une clé étrangère unique identifie le travail; un trigger écrit ou supprime la tâche dans la même transaction que l'état du message. La table a RLS, aucune politique cliente et aucun droit `anon`/`authenticated`.
- La réconciliation des appels utilise la ligne métier `call_legs` elle-même : `reconcile_after` et `reconcile_attempts` déterminent le prochain passage. L'appel et sa connexion sont donc persistés dans la transaction métier, sans copie d'un payload vers une seconde file.
- Le `jobId` stable est l'identifiant de ressource (`message_id` ou `call_legs.id`). Les RPC métier dédupliquent les événements fournisseur. Les tâches ne sérialisent pas de payload JSON versionné : le worker recharge l'état courant, et les évolutions de format se font par migrations additives.
- Le worker traite les éléments dus en série, par lots de 20. Les SMS restent incertains et passent en revue manuelle après les reprises prévues; le worker ne crée jamais un second SMS. Les erreurs d'appel augmentent un backoff plafonné à une heure.
- Une seule réplique worker est requise pour cette stratégie de polling. Les appels Twilio du worker sont des lectures; la projection SQL est idempotente. Après mise à jour durable, le prochain échéancier est repoussé; si le processus tombe avant cela, l'élément reste dû et sera relu.

## Limites et suite

Cette stratégie utilise des tables applicatives persistées plutôt que Supabase Queues/`pgmq`; elle garde les tâches liées aux lignes métier et évite un deuxième payload à synchroniser. Elle n'offre pas de bail de visibilité ou de dead-letter queue générique. Les tests de crash avant/après effet, l'observation d'une charge réelle et les alertes externes restent nécessaires avant d'augmenter le nombre de répliques.
