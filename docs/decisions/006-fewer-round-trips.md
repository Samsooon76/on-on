# Décision 006 — Un écran, un aller-retour

- Date : 2026-09-28
- Statut : appliqué au prototype; la migration `20260928210000_conversation_loading_performance` doit être appliquée avant le déploiement de l'API.
- Contexte : l'API et Supabase sont éloignés (mesuré : ~180 ms par appel API → Supabase). Les écrans enchaînaient 6 à 8 appels à Supabase (liste des conversations : 8, fil : 6, historique d'appels : 6), et le démarrage des clients trois niveaux de requêtes. La base elle-même répond en quelques millisecondes : le coût venait du nombre d'allers-retours, pas des requêtes SQL.

## Décisions

- **Un écran = une fonction SQL.** `list_line_conversations`, `list_line_calls`, `conversation_thread` et `mark_conversation_read` regroupent contrôle d'accès, page de données, aperçu, indicateur de non lu et libellé de contact. Elles sont `SECURITY INVOKER` : la RLS s'applique toujours et chaque fonction vérifie aussi, explicitement, l'appartenance active et l'affectation de ligne (`assigned_line_scope`). Sans droit, elles retournent `NULL`, que l'API traduit en 404. Les contrats HTTP ne changent pas.
- **Vérification locale du JWT pour les lectures.** Le projet publie une clé ES256. `GET`/`HEAD` vérifient signature, expiration, rôle et audience sans appeler Auth. Les écritures (`POST`, `PUT`, `PATCH`, `DELETE`) gardent l'appel à Auth. Repli automatique sur Auth pour un jeton symétrique historique ou si les clés sont injoignables. Compromis accepté : une session révoquée (déconnexion, compte suspendu) reste utilisable en lecture jusqu'à l'expiration de son jeton; les droits sur l'organisation, la ligne et les contacts sont, eux, relus à chaque requête par la RLS. Si ce délai n'est pas acceptable, ramener `LOCALLY_VERIFIED_METHODS` (`apps/api/src/authentication.ts`) à un ensemble vide rétablit l'ancien comportement.
- **La RLS fait foi pour les appareils et les contacts.** Les pré-lectures des appartenances, redondantes avec les politiques, sont supprimées.
- **Corrections SQL rétro-compatibles.** `latest_conversation_messages` lit un message par conversation au lieu de trier tous les messages; `list_pending_outbound_messages`, appelée à chaque démarrage, part des demandes d'envoi de l'utilisateur et atteint chaque message par clé primaire, au lieu de relire tous les messages de ses lignes (la jointure sur `id::text` n'était pas indexable). Signatures et résultats inchangés, vérifiés par les tests SQL.
- **Statistiques.** Lecture des appels, files, appareils et instantané en parallèle, puis détails par lots de 100 appels avec six lots en vol; les appareils de l'organisation sont lus une fois. Le nombre d'allers-retours ne croît plus avec le nombre de lots.
- **Curseurs.** Les nouvelles routes conservent la précision à la microseconde de l'horodatage du curseur; arrondir à la milliseconde pouvait sauter des lignes créées dans la même milliseconde.
- **Clients.** La boîte n'attend plus les appareils ni les appels pour s'afficher; le dernier état connu de la boîte est conservé sur l'appareil (Web : `localStorage`, iOS : `expo-secure-store`) et affiché pendant le chargement; les fils déjà ouverts sont gardés en mémoire (20 au plus); sur iOS, un SMS ou un appel reçu ne recharge plus que ce qui a changé (l'espace complet n'est rechargé qu'au retour au premier plan ou à la reconnexion du temps réel). Le cliché contient des numéros et des aperçus de messages : il est limité à 40 conversations et 40 appels, expire après sept jours, est propre à l'utilisateur et est supprimé à la déconnexion.
- Le verrou d'envoi SMS est relâché dès que la vérification des envois incertains revient vide (Web et iOS); il reste actif si un SMS est à reprendre ou si la vérification échoue.

## Ordre de déploiement

1. `pnpm db:migrations:online` puis `pnpm db:push:online` (vérifier le projet affiché) : la migration est additive et l'ancienne API continue de fonctionner.
2. Déployer API et Web (`main`). L'API dépend des nouvelles fonctions : sans la migration, les écrans concernés répondent 503.
3. Reconstruire l'application iOS. Les clients sont compatibles avec l'ancienne et la nouvelle API.

Retour arrière : redéployer la version précédente de l'API; les fonctions ajoutées restent inertes.
