# Proposition : MCP Onoff pour les utilisateurs

Date : 26 septembre 2026. Statut : proposition initiale ; V1 et V2 sont désormais implémentées dans le dépôt. Le [guide d’activation](runbooks/mcp-setup.md) décrit l’architecture livrée, les contrôles et les étapes de configuration distante.

## Recommandation

Proposer un connecteur MCP distant pour permettre à chaque utilisateur de consulter ses données Onoff depuis un assistant compatible. Première livraison : contacts, conversations SMS et historique d'appels. Deuxième livraison : modifications de contacts et envoi de SMS après validation. Pour la voix, préparer un appel dans le composeur Onoff existant.

Le périmètre retenu est l'exposition des fonctions d'Onoff aux assistants des utilisateurs. La compatibilité de chaque client et de son parcours OAuth devra être testée avant de l'annoncer.

Exemples d'usage :

- « Retrouve le numéro de Sophie Martin. »
- « Résume les derniers SMS échangés avec ce client. »
- « Montre les derniers appels de ma ligne. »
- Dans un second temps : « Prépare un SMS à Sophie pour confirmer le rendez-vous. »

L'assistant réalise les résumés à partir des données autorisées. Ce périmètre ne nécessite pas de modèle d'IA hébergé dans Onoff.

## Parcours utilisateur proposé

1. Dans **Réglages → Intégrations → Assistants IA**, afficher l'adresse du connecteur et les instructions des clients validés.
2. L'utilisateur ajoute cette adresse dans son assistant et se connecte avec son compte Onoff.
3. Une page de consentement présente l'assistant, l'organisation, les lignes sélectionnées et les permissions demandées. La consultation est le choix initial.
4. Les appels d'outils sont limités à cette autorisation et aux droits actuels du membre.
5. L'utilisateur retrouve ses connexions, leur dernière utilisation et un bouton **Révoquer**. Une nouvelle requête doit être refusée après révocation, même si le jeton n'a pas expiré.

La page doit expliquer que les données consultées sont transmises à l'assistant choisi. Le consentement à connecter un assistant et la validation d'un envoi sont deux décisions distinctes.

## Outils de première version

Noms indicatifs ; réponses structurées, pagination bornée et champs explicitement sélectionnés.

| Outil proposé | Utilité | Base existante |
| --- | --- | --- |
| `get_context` | Identifier le compte et les organisations autorisées pour cette connexion | `GET /v1/me`, `GET /v1/organizations`, `GET /v1/services` |
| `list_lines` | Afficher les lignes sélectionnées auxquelles le membre a toujours accès | `GET /v1/organizations/:orgId/lines` |
| `search_contacts` | Rechercher par nom, email ou numéro | `GET /v1/organizations/:orgId/contacts?q=` |
| `list_conversations` | Retrouver les échanges d'une ligne autorisée | `GET /v1/lines/:lineId/conversations` |
| `get_conversation_messages` | Consulter une page de messages pour répondre ou résumer | `GET /v1/conversations/:id/messages` |
| `list_calls` | Consulter l'historique d'une ligne autorisée | `GET /v1/lines/:lineId/calls` |

Ces routes existent dans [app.ts](../apps/api/src/app.ts). Le tableau décrit leur réutilisation métier, pas une conversion automatique en outils MCP.

Les contacts sont partagés à l'échelle de l'organisation dans le modèle actuel : sélectionner une ligne ne suffit pas à restreindre le carnet de contacts. Le consentement doit le préciser.

La recherche plein texte dans les SMS et les filtres de dates/résultats sur l'historique standard ne sont pas exposés par ces routes. Une recherche exhaustive d'appels manqués sur une période demande des filtres serveur supplémentaires ; ne pas présenter une page partielle comme un résultat complet.

Les statistiques agrégées disposent d'une route séparée, réservée aux administrateurs (`apps/api/src/statistics.ts`). Leur exposition éventuelle constitue une permission et un lot distincts.

## Deuxième version : actions

| Outil proposé | Comportement | Travail complémentaire |
| --- | --- | --- |
| `create_contact` / `update_contact` | Ajouter ou corriger un contact après accord de l'utilisateur | Permission d'écriture déléguée et contrôle des reprises |
| `prepare_sms` | Présenter destinataire, ligne, texte et estimation des segments | Brouillon serveur identifié et expirant |
| `send_prepared_sms` | Envoyer exactement le brouillon validé | Validation liée au contenu, à l'utilisateur et à la connexion ; reprise idempotente |
| `get_sms_action` | Consulter le résultat d'une action et les envois incertains | Contrat de suivi, fondé sur les données de messages existantes |
| `prepare_call` | Retourner un lien vers le composeur web prérempli | Réutiliser le paramètre `callTo`, avec destination validée et origine web configurée |

Pour le SMS, recommander d'abord une validation dans Onoff : le serveur conserve la preuve de validation du brouillon immuable, puis applique une clé d'idempotence stable à l'envoi. Un simple argument `confirmed: true` fourni par le modèle n'est pas une preuve de consentement. La validation native d'un assistant pourra être intégrée quand son fonctionnement sera vérifié.

Un résultat `unknown` ou non confirmé reste à vérifier ; il ne déclenche aucun renvoi automatique. Les quotas, restrictions de destinataires, permissions de ligne et la pause des opérations existants doivent continuer à s'appliquer. Voir [le contrat API](api.md).

Le lien d'appel reprend le parcours de [l'extension Chrome](extension.md). L'utilisateur choisit sa ligne et lance l'appel depuis l'application. `POST /v1/call-intents` prépare une intention associée à un appareil ; il ne suffit pas à faire parler un assistant au téléphone. Un agent vocal autonome serait un projet supplémentaire.

Les achats de numéros, changements de rôles, modifications d'IVR et campagnes d'envoi restent hors de ce périmètre.

## Architecture proposée

```text
Assistant de l'utilisateur
          |
          | HTTPS + OAuth
          v
API Onoff : /mcp
          |
          | Identité vérifiée + autorisation déléguée courante
          v
Services métier communs à /v1 et /mcp
          |
          v
Contrôles d'accès existants, RLS et services fournisseur
```

Intégrer initialement le point d'entrée MCP dans l'API Fastify. Extraire progressivement les opérations utiles de `app.ts` dans des services réutilisables afin de conserver les validations et les règles d'accès à un seul endroit. Les schémas de `packages/contracts` servent de base aux entrées et sorties. Une application `apps/mcp` indépendante n'est pas nécessaire pour ce premier lot.

Utiliser le transport **Streamable HTTP** sur une adresse HTTPS `/mcp`. La révision MCP 2026-07-28 a modifié le transport et supprimé les sessions de protocole ; choisir et épingler un SDK selon les versions réellement supportées par les clients retenus. Valider les origines lorsqu'elles sont présentes. [Spécification du transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).

L'accès distant doit utiliser OAuth avec PKCE, découverte du serveur d'autorisation et métadonnées de ressource protégée. Vérifier signature, émetteur, expiration et audience destinée à la ressource MCP. Ne pas accepter un jeton destiné à une autre ressource ni le retransmettre aveuglément à une API en aval. [Autorisation MCP](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

## Point principal à résoudre : les permissions déléguées

L'API actuelle vérifie un jeton Supabase avec `auth.getUser()` puis crée un contexte utilisateur. Les contrôles d'organisation et de ligne existent dans `apps/api/src/repositories/access.ts` et dans les politiques SQL. L'étude du code local n'a pas trouvé de serveur MCP ni de contrôle d'autorisation déléguée par client OAuth.

Supabase documente un serveur OAuth et un parcours MCP réutilisant l'identité existante. C'est la première option à évaluer, sans supposer qu'elle est activée sur le projet. [Authentification MCP Supabase](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication).

Attention : les scopes OIDC `openid`, `email` et `profile` ne limitent pas l'accès aux tables ni aux routes métier. Les jetons OAuth comportent un `client_id` exploitable dans les politiques RLS ; l'audience peut nécessiter une configuration spécifique. [Sécurité des jetons OAuth Supabase](https://supabase.com/docs/guides/auth/oauth-server/token-security).

Prévoir une autorisation serveur liant **utilisateur + client OAuth + organisation + lignes + capacités + état de révocation**. Capacités métier proposées : lecture des contacts, lecture des SMS, lecture des appels, puis écriture des contacts et envoi des SMS. Ce sont des droits à implémenter dans Onoff, pas des scopes Supabase supposés disponibles.

À chaque action, appliquer l'intersection entre cette autorisation et les droits actuels de l'utilisateur. Une affectation retirée, une suspension ou une révocation doit empêcher les nouvelles opérations.

La restriction doit couvrir tous les chemins accessibles au jeton : `/mcp`, `/v1`, accès direct aux tables, RPC et Realtime. Ajouter seulement un contrôle dans les outils MCP laisserait une possibilité de contournement. En particulier, un jeton limité à la lecture ne doit pas pouvoir appeler directement une route d'envoi ou une RPC de mutation. Réviser les politiques permissives existantes, les fonctions privilégiées et leurs droits d'exécution en conséquence.

Le prototype OAuth doit démontrer l'audience dédiée, la découverte, le renouvellement, la révocation et la conservation du contexte utilisateur sous RLS. Si le serveur OAuth choisi ne satisfait pas ces exigences, revoir cette intégration avant de distribuer des jetons aux assistants.

## Livraison proposée

1. **Valider l'authentification** : un client MCP cible, consentement, audience, permissions déléguées et tentative de contournement via `/v1` et la Data API.
2. **Livrer la consultation** : six outils, page Intégrations, révocation, pagination et journal minimal des accès.
3. **Ajouter les actions** : contacts, brouillons SMS, validation et suivi des résultats ; lien vers le composeur pour les appels.

Pour le journal, conserver utilisateur, client, organisation, outil, résultat et identifiant de corrélation. Éviter d'y recopier texte des SMS, jetons et numéros complets. Les messages reçus sont des données non fiables : leur contenu ne doit jamais modifier les permissions ou autoriser une action.

Critères de recette avant ouverture :

- Un compte ne consulte aucune autre organisation ou ligne non autorisée, même avec un identifiant deviné.
- Une connexion de consultation échoue sur toutes les mutations, y compris les chemins directs.
- La révocation de la connexion ou des droits bloque la requête suivante sans attendre l'expiration du jeton.
- Expiration, renouvellement, mauvais émetteur et mauvaise audience sont correctement traités.
- Les résultats paginés signalent clairement leur caractère partiel.
- Pour les SMS, une répétition de la même action ne recrée pas d'envoi ; un contenu modifié exige une nouvelle validation ; un résultat incertain reste en attente de vérification.
- Le parcours complet fonctionne dans chacun des assistants annoncés comme compatibles.

Cette proposition ne vérifie pas la configuration distante de Supabase, les services Twilio actifs ni la compatibilité réelle d'un assistant. Ces vérifications appartiennent au premier lot d'implémentation.
