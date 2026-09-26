# Connecteur MCP Onoff : V1 et V2

Le dépôt fournit un serveur MCP distant dans l’API Fastify, les permissions par connexion, le consentement OAuth et les écrans **Réglages → Assistants IA**. L’activation distante nécessite la migration et la configuration Auth décrites ci-dessous. Le code n’active pas automatiquement les intégrations sur le projet hébergé.

## Fonctions livrées

| Outil | Permission | Fonctionnement |
| --- | --- | --- |
| `get_context` | Connexion active | Compte, organisation consentie, permissions et disponibilité des services |
| `list_lines` | Connexion active | Lignes sélectionnées auxquelles le membre a encore accès |
| `search_contacts` | `contacts:read` | Recherche par nom, email ou numéro ; pagination |
| `list_conversations` | `messages:read` | Conversations d’une ligne autorisée |
| `get_conversation_messages` | `messages:read` | Page de SMS, avec curseur vers les messages plus anciens |
| `list_calls` | `calls:read` | Historique paginé d’une ligne |
| `create_contact` | `contacts:write` | Création idempotente grâce à `requestKey` |
| `update_contact` | `contacts:write` | Mise à jour avec version et `requestKey` ; refus d’un conflit |
| `prepare_sms` | `messages:send` | Brouillon immuable, lien de validation, validité de 30 minutes |
| `get_sms_action` | `messages:send` | État du brouillon et résultat fournisseur connu |
| `send_prepared_sms` | `messages:send` | Envoi d’un brouillon déjà validé dans Onoff ; reprise sans nouvel envoi |
| `prepare_call` | `calls:prepare` | Lien vers le composeur web ; l’utilisateur choisit sa ligne et lance l’appel |

Les contacts sont partagés dans toute l’organisation consentie. Les permissions des lignes ne limitent pas le carnet de contacts. Chaque connexion ne concerne qu’une organisation. Pour changer ses permissions, la révoquer dans Onoff puis relancer la connexion depuis l’assistant ; une nouvelle autorisation du même client remplace la précédente.

Les outils paginés acceptent `limit` de 1 à 50 et `cursor`. `partial: true` signifie qu’il reste des résultats. Il n’y a pas encore de recherche plein texte des SMS ni de filtrage de l’historique par période. Les statistiques, achats de numéros, rôles et IVR ne sont pas exposés.

## Architecture et accès

`apps/api/src/mcp.ts` utilise `@modelcontextprotocol/server` 2.1.0, avec Streamable HTTP sur `/mcp`. Le SDK traite les requêtes 2026-07-28 et les clients 2025 en mode sans session. La compatibilité de protocole est testée ; cela ne vaut pas certification d’un assistant commercial particulier.

Supabase reste le fournisseur d’identité et le serveur OAuth. Le hook `public.onoff_mcp_access_token_hook` transforme les jetons OAuth en jetons de rôle **`onoff_mcp`**, avec audience égale à l’URL `/mcp`, `client_id` et `mcp_grant_id`. Il conserve les sessions ordinaires. Il s’applique à tous les clients OAuth de ce projet : un client sans autorisation Onoff est refusé. Ne pas l’installer sur un projet possédant d’autres intégrations OAuth sans vérifier leur besoin.

Ce rôle n’hérite pas de `authenticated`. Il a uniquement des lectures de colonnes explicitement accordées, soumises aux politiques RLS de l’organisation, des lignes et des permissions consenties. Il ne peut pas appeler les RPC métier de mutation ni s’abonner à Realtime. Les jetons délégués sont également refusés sur toutes les routes `/v1`, notamment les routes de consentement et de validation des SMS.

Les mutations MCP passent par des fonctions réservées à `service_role`, qui revérifient l’acteur, l’autorisation, l’adhésion et la ligne. Le rôle serveur n’est jamais retourné au client. Les modifications de contacts réutilisent les fonctions métier existantes ; les SMS réutilisent `prepare_outbound_message` et le même module de livraison que `/v1/messages`.

La révocation ferme immédiatement l’autorisation Onoff et tente également de révoquer le consentement et les sessions OAuth chez Supabase. Une erreur de cette seconde étape n’annule pas la révocation locale. Les jetons déjà émis restent soumis au contrôle de l’autorisation courante ; le renouvellement d’une ancienne session ne peut pas adopter une nouvelle autorisation. La table serveur `mcp_oauth_sessions` conserve cette association, même lorsque Auth reconstruit les claims au renouvellement.

## Activation sur le projet hébergé

Effectuer les étapes dans cet ordre, avec `MCP_ENABLED=false` jusqu’à la fin :

1. **Appliquer la migration** `supabase/migrations/20260926121929_mcp_user_integrations.sql` sur le projet Onoff visé, via le flux existant `pnpm db:migrations:online` puis `pnpm db:push:online`. La migration crée un rôle PostgreSQL, les tables privées aux clients, les politiques RLS et les fonctions. Relire toute autre migration en attente avant le push. Exécuter les advisors de sécurité après application.
2. **Déployer le Web et l’API ensemble**, avec leurs URL publiques HTTPS. La page `/oauth/consent` est servie par le Web et utilise la connexion Onoff existante. `API_PUBLIC_URL` doit être l’origine canonique de l’API et `WEB_PUBLIC_URL` l’origine canonique du Web ; les changer exige une nouvelle connexion des assistants.
3. Dans **Supabase → Authentication → Hooks**, activer le hook d’accès `public.onoff_mcp_access_token_hook`. Conserver OAuth désactivé jusqu’à ce que ce hook soit installé. Si le projet possédait déjà des sessions OAuth, les révoquer avant l’ouverture pour qu’aucun ancien jeton de rôle `authenticated` ne reste utilisable via la Data API.
4. Dans **Authentication → OAuth Server**, activer OAuth 2.1 et définir le chemin d’autorisation **`/oauth/consent`**. La Site URL Auth doit correspondre au Web public. Utiliser des clés de signature asymétriques pour la validation JWKS et OIDC. Configurer l’enregistrement dynamique des clients lorsque les assistants retenus l’exigent, ou préenregistrer les clients et leurs URI de retour exactes. Ne pas créer un second mécanisme de connexion par mot de passe dans le MCP.
5. Configurer l’API avec `MCP_ENABLED=true`, `SUPABASE_SECRET_KEY` côté serveur uniquement, `API_PUBLIC_URL`, `WEB_PUBLIC_URL` et `ALLOWED_ORIGINS`. Ajouter les origines exactes des clients navigateur utilisés si leurs requêtes portent un en-tête `Origin`. Aucun wildcard n’est accepté. Les clients serveur sans `Origin` passent par la vérification OAuth habituelle.
6. Dans un assistant compatible, ajouter **`https://<origine-api>/mcp`**. Se connecter avec un compte existant, choisir une organisation, les lignes et les permissions. Vérifier d’abord `get_context` et une lecture, puis la révocation, puis une nouvelle connexion.
7. Pour la V2 SMS, conserver les configurations habituelles : `SMS_ENABLED`, credentials Twilio, `SMS_ALLOWED_RECIPIENTS`, `TWILIO_ALLOWED_DESTINATIONS`, configuration SMS de l’organisation et droits SMS de la ligne. Les plafonds de démonstration et `OPERATIONS_PAUSED` continuent à s’appliquer.

Les blocs correspondants dans `supabase/config.toml` restent désactivés et documentent la configuration ; modifier ce fichier n’active pas les fonctionnalités du projet Supabase hébergé.

Documentation de référence : [OAuth et MCP dans Supabase](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication), [hook de jeton](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook), [sécurité des jetons et RLS](https://supabase.com/docs/guides/auth/oauth-server/token-security), [autorisation MCP](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

## Validation et reprise d’un SMS

`prepare_sms` reçoit une `requestKey` UUID créée pour cette action et retourne `approvalUrl`. Réutiliser la même clé conserve le même brouillon ; modifier son contenu avec cette clé est refusé.

Le lien ouvre **Réglages → Assistants IA** et affiche l’assistant, le destinataire, la ligne, le texte exact et une estimation des segments. **Valider et envoyer ce SMS** approuve le brouillon puis déclenche son envoi. L’assistant peut aussi appeler `send_prepared_sms` après la validation, notamment si le navigateur s’est fermé entre les deux étapes.

Aucun paramètre fourni par l’assistant ne peut valider un brouillon. Un refus est définitif pour ce brouillon ; un changement de destinataire, de ligne ou de texte demande un nouveau brouillon et une nouvelle validation.

La préparation SQL lie définitivement le brouillon à un message. Ce lien empêche une nouvelle émission, même après expiration de la rétention de la clé d’idempotence HTTP. Un arrêt du serveur après préparation ou un timeout fournisseur laisse un résultat à vérifier ; la reprise ne recrée pas de message. Le worker et les procédures existantes traitent les messages incertains.

Les états `sent`, `delivered`, `failed`, `undelivered`, `submitting` et `unknown` restent distincts. Une réponse HTTP réussie n’est pas à elle seule une preuve de livraison.

## API de gestion utilisateur

Ces routes exigent une session Onoff ordinaire. Les jetons MCP y sont refusés.

| Route | Usage |
| --- | --- |
| `GET /v1/mcp/config` | Disponibilité et adresse du connecteur |
| `GET /v1/mcp/authorizations/:id` | Détails de la demande OAuth, lus auprès d’Auth avec la session vérifiée |
| `GET /v1/mcp/grants` | Connexions actives de l’utilisateur |
| `POST /v1/mcp/grants` | Consentement métier rattaché au client vérifié de la demande OAuth |
| `POST /v1/mcp/grants/:id/revoke` | Révocation locale, puis révocation OAuth |
| `GET /v1/mcp/sms-drafts` | 50 derniers brouillons de l’utilisateur, avec indicateur de liste partielle |
| `GET /v1/mcp/sms-drafts/:id` | Brouillon et statut d’envoi, si les droits sont toujours actifs |
| `POST /v1/mcp/sms-drafts/:id/decision` | Validation ou refus explicite |
| `POST /v1/mcp/sms-drafts/:id/send` | Envoi après validation |

La découverte OAuth est publiée sur `/.well-known/oauth-protected-resource/mcp`, également accessible à la racine `/.well-known/oauth-protected-resource`. Les erreurs 401 exposent `WWW-Authenticate`. Le MCP partage une limite persistante de 120 requêtes par utilisateur par minute ; l’envoi garde sa limite SMS propre.

Le journal `mcp_audit_events` conserve le nom de l’outil, la connexion, le résultat et l’identifiant de requête. Il ne recopie pas le texte des SMS ou les jetons. Une erreur de persistance du journal est signalée dans les logs API.

Les brouillons contiennent des données personnelles. La politique globale de rétention du projet reste à définir ; ne pas purger les liens `message_id` des brouillons envoyés sans préserver leur protection contre les reprises.

## Vérifications

- Tests API : JWT vérifié, audience, rôle, émetteur, expiration, découverte, protocoles 2025 et 2026, droits, révocation, approbation et reprise SMS, timeout fournisseur.
- `pnpm test:admin:db` : migrations dans PostgreSQL isolé, rôle sans privilèges hérités, colonnes privées, isolation des organisations et lignes, droits révoqués, hook OAuth, conflits de version/reprise, validation humaine, refus, expiration et lien permanent vers le message.
- Builds et types de l’API, du Web et des contrats.
- Recette navigateur des composants de connexion et de validation avec données fictives ; aucun SMS réel n’est envoyé par cette recette.

La connexion OAuth sur le projet hébergé et la recette dans les assistants retenus doivent être effectuées après configuration. Les tests locaux ne remplacent pas cette vérification distante.
