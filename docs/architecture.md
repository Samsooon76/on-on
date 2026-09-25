# Architecture

Le navigateur et les clients natifs appellent l'API Fastify au moyen de `packages/api-client`. Supabase Auth fournit les sessions. L'API vérifie chaque JWT avec Auth, puis réalise les requêtes métier avec le JWT utilisateur afin que Postgres applique les politiques RLS. Les clients ne reçoivent jamais une clé privilégiée.

Les webhooks Twilio n'ont pas de JWT utilisateur. Leur vérification de signature précède toute écriture; leur persistance nécessite la clé serveur Supabase. Les tokens d'accès Voice sont produits côté serveur avec des identifiants API dédiés. L'audio reste entre le SDK et Twilio.

PostgreSQL est la source de vérité. Realtime ne transporte que des invalidations minimales sur des canaux privés; après reconnexion, les clients relisent l'API. L'API est un monolithe modulaire. `apps/worker` relit les appels voix actifs depuis `call_legs`, vérifie les SMS incertains par `MessageSid`, marque ceux sans SID pour intervention manuelle, et expire le travail préparatoire et les fenêtres de débit. Les échéances et le backoff sont enregistrés dans PostgreSQL, donc le worker reprend après redémarrage. Il ne recrée jamais un SMS incertain.

Les politiques des canaux Realtime privés sont évaluées lors de la souscription et restent en cache sur cette connexion jusqu'à réception d'un nouveau JWT ou expiration. Les changements de session renouvellent le JWT et recréent les abonnements; un accès à l'API relit toujours les droits courants via RLS. Le délai maximal de révocation Realtime dépend de l'expiration JWT configurée pour le projet et doit être confirmé dans la console avant mise en production. [Autorisation Realtime Supabase](https://supabase.com/docs/guides/realtime/authorization).

Les SDK vocaux restent derrière `packages/voice-web` et `packages/voice-native`, qui implémentent `packages/voice-contract`. Les écrans Web et mobile consomment des événements/actions communs sans recevoir directement les objets Twilio. Le paquet natif ajoute uniquement la gestion des invites, la reprise des appels natifs et le choix de sortie audio propre à iOS/Android.

`packages/api-client` est le transport commun des clients : il reçoit le jeton de session depuis la plateforme, propage un identifiant de requête, sérialise les paramètres de pagination et retourne les erreurs avec statut/code. Il ne met pas les mutations en retry automatique. Les états d'écran continuent à être relus depuis l'API après un événement Realtime ou une reconnexion.
