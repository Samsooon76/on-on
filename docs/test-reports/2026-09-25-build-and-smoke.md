# Rapport de build et smoke tests — 2026-09-25

## Vérifications réussies

| Vérification | Résultat |
|---|---|
| `CI=true pnpm typecheck` | Tous les workspaces, dont le worker et le mobile, passent |
| `CI=true pnpm test` | 33 tests réussis : 3 contrats, 4 tests de segmentation API client et 26 API; les adaptateurs voix, le worker, le web et le mobile n'ont pas encore de tests unitaires |
| `CI=true pnpm lint` | Passe; le script de lint exécute le typecheck strict des workspaces |
| `CI=true pnpm build` | API, worker, packages et Web passent; Vite produit le bundle production |
| Worker | Compilation TypeScript réussie; reprise des appels à partir d'états persistés et backoff stocké en base; les appels Twilio réels ne sont pas configurés |
| Expo config | Passe pour le schéma mobile `onoff`, iOS et Android |
| Expo prebuild | Projets natifs iOS/Android générés avec le plugin Twilio et SecureStore |
| Expo export | Bundles Hermes iOS et Android générés par Metro |
| Serveur statique Web | `/health/live` répond 200, route SPA répond 200, asset JS répond 200 avec cache immuable, tentative de traversal ne retourne pas de fichier privé |
| Supabase hébergé | À la passe initiale : 13 migrations et 18 tables RLS. Les migrations additives suivantes ajoutent la réconciliation SMS, la reprise après reconnexion et l'état de lecture des conversations |
| Versions de diagnostic | API `/health/live` et `/health/ready`, Réglages Web et Diagnostic Mobile lisent la version des `package.json`; versions courantes `0.1.0` |
| Mode maintenance | Revue statique: `OPERATIONS_PAUSED=true` renvoie `503 operations_paused` sur la création d'appel et de SMS; les clients affichent le message de réponse. Le mode ne termine pas les appels actifs. Pas d'essai runtime sur un serveur hébergé |
| Métriques client vocales | Migration `20260925145647_voice_client_diagnostic_rate_limit` appliquée sur Supabase en ligne; l'opération `voice_client_diagnostic` est limitée à 10/5 min/utilisateur. Les permissions du RPC restent réservées à `service_role`. Les événements n'acceptent que des catégories, plateforme, version et durée bornée; le code client/API passe le typecheck. Aucun événement client réel n'a été émis pendant cette recette |

Le workflow `.github/workflows/ci.yml` se déclenche sur les pull requests et les pushs vers `main`; il lance `lint`, `typecheck`, `test` et `build` sur tout le workspace. Un changement de package partagé passe donc par les contrôles de ses consommateurs. La configuration a été revue et le commit initial a été poussé sur `main`; l'exécution hébergée de la CI reste à vérifier.

Les migrations ont été vérifiées et appliquées uniquement au projet Supabase hébergé `mzqycbxnbyxeivdduhrl`; aucune instance Supabase locale n'a été démarrée ou utilisée.

Les deux dernières migrations de la passe initiale sont `20260925093050_operational_recovery_and_rate_limits` et `20260925094029_restrict_operational_rate_table`.

## Vérifications ciblées après le client API partagé

| Vérification | Résultat |
|---|---|
| `./node_modules/.bin/tsc -p packages/api-client/tsconfig.json` | Passe; client commun ajouté au Web et au mobile |
| `./node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit` | Passe après configuration des limites HTTP et de l'arrêt propre |
| `./node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit` | Passe après le nettoyage du contexte d'organisation et les invalidations ciblées |
| `./node_modules/.bin/tsc -p apps/mobile/tsconfig.json --noEmit` | Passe après les mêmes changements de contexte et Realtime |

## Vérifications ciblées du 25 septembre — idempotence et reprise SMS

| Vérification | Résultat |
|---|---|
| TypeScript Contracts, API, Worker, Web et Mobile | Passe avec `tsc` direct; le paquet Contracts a été rebâti pour inclure les types de la migration |
| Supabase en ligne `onoffv2` | Migrations `20260925103818_sms_reconciliation_queue`, `20260925105308_restore_uncertain_sms_attempts` et `20260925111659_conversation_unread_status` présentes; RLS activée; `anon` et `authenticated` ne peuvent pas lire la file; `service_role` le peut |
| État de la file après migration | Aucune tâche et aucun cas de revue manuelle à retraiter |
| RPC `list_pending_outbound_messages` | Exécutable par `authenticated`; la fonction SQL limite les SMS à vérifier à leur auteur encore membre et affecté à la ligne |
| RPC `conversation_unread_status` | Migration appliquée sur l'instance hébergée; `SECURITY INVOKER`, requêtes limitées à la ligne et aux conversations demandées; l'API appelle la fonction avec le JWT utilisateur |
| Permissions de `conversation_unread_status` | En ligne : `anon` ne peut pas exécuter; `authenticated` le peut; la fonction n'est pas `SECURITY DEFINER` |
| Web et Mobile — non-lus et estimation de segments | Ajoutés; aucune fixture ni aucun SMS réel utilisé |
| TypeScript après les changements du 25 septembre | Contracts, API client, API, worker, Web et Mobile passent avec `tsc` direct |
| Tests unitaires | Non relancés après ces changements |

## Appareil gagnant des appels entrants

| Vérification | Résultat |
|---|---|
| Migrations Supabase hébergées `20260925114749_record_answered_call_device` et `20260925115024_preserve_winning_call_reservation` | Appliquées au projet `onoffv2`; la connexion enfant doit appartenir à une ligne du compte fournisseur, être un appel entrant déjà répondu et correspondre à une identité d'appareil de la même organisation. La transaction verrouille l'appel, sélectionne un seul gagnant et libère les réservations des autres utilisateurs |
| Permissions de `record_answered_call_device` | En ligne : fonction `SECURITY DEFINER` appelable par `service_role` seulement; `anon` et `authenticated` n'ont pas le droit d'exécution |
| API et worker | Après application de l'état Twilio, l'API et la réconciliation relient la connexion répondue à l'appareil ciblé par `To=client:...`; une association existante ne peut pas être remplacée. La réservation du gagnant reste active jusqu'à la fin ou l'expiration contrôlée de l'appel |
| TypeScript Contracts, API et Worker | Passe avec `tsc` direct après ajout du RPC et des types |
| Appels réels / tests unitaires | Non effectués; aucun credential Twilio ni appareil n'est configuré, aucun test n'a été lancé |

## Fin et durée des appels

La migration `20260925120128_correct_call_connection_outcomes` est appliquée au projet hébergé. Une fin `completed` d'une connexion enfant confirme la réponse, même si sa durée Twilio vaut zéro. La durée métier provient seulement de la connexion enfant terminée; les connexions perdantes et la durée du parent ne l'écrasent pas. L'endpoint d'action `<Dial>` utilise `DialCallSid`/`DialCallDuration` pour une fin réussie et son statut agrégé pour l'absence de réponse.

Les callbacks utilisent toujours l'accusé HTTP après persistance durable. Aucun corps de webhook complet n'est stocké dans `provider_events`; le choix de rétention et de masquage des champs sensibles reste à formaliser.

La migration `20260925120831_order_voice_provider_events` ajoute `provider_event_at` et `provider_sequence_number`; `received_at` conserve l'heure du serveur. Le reducer compare les séquences pour la même ressource `CallSid` et ignore les événements dépassés. Le typecheck des packages Contracts, API et Worker passe après le changement. La fonction SQL avec métadonnées reste exécutable uniquement par `service_role`; le wrapper de compatibilité est `SECURITY INVOKER` et lui aussi réservé à `service_role`. Aucun test unitaire n'a été lancé.

La migration `20260925121141_index_sms_reconciliation_foreign_key` ajoute l'index couvrant la clé étrangère de la file SMS. Le nouvel avis `unindexed_foreign_keys` a disparu; l'analyse signale encore 35 index non utilisés sur cette base quasi vide et l'avis informatif de capacité Auth fixe à 10 connexions.

## Annulation d'intention d'appel

La migration hébergée `20260925122511_cancel_unused_call_intent` ajoute une annulation idempotente réservée à `service_role`; elle ne libère que la réservation `preparing` dont l'appel n'a pas été consommé et refuse les intentions d'un autre utilisateur. L'API authentifiée expose `POST /v1/call-intents/:id/cancel`; Web et Mobile l'appellent si la préparation cliente échoue. Permissions en ligne : `anon`/`authenticated` refusés, `service_role` autorisé. Contracts, API, Web, Mobile et Worker passent le typecheck. Aucun appel réel ni test unitaire n'a été lancé.

## Propriété de la voix entre onglets

Le Web utilise un verrou exclusif par utilisateur avec Web Locks. Les onglets en attente affichent l'état et ne peuvent pas démarrer un appel; le verrou est libéré à la fermeture ou au démontage et transféré au suivant. Le `device_id` du navigateur est partagé via `localStorage` par utilisateur et organisation pour garder une identité stable. TypeScript Web et le build Vite de production passent. Aucun essai réel de fermeture/reprise entre navigateurs ni test unitaire n'a été lancé.

## Renouvellement push natif et annulation d'invitation

L'application Mobile récupère un JWT Voice neuf au retour au premier plan et toutes les 50 minutes, puis réenregistre le SDK natif avec `Voice.register()`. Les renouvellements simultanés sont ignorés et une réponse arrivée après changement de session ou d'appareil ne réinscrit pas l'ancien appareil. L'adaptateur natif traite aussi `CallInvite.Event.Cancelled` au niveau du client vocal global et expose la sélection des routes audio. Le typecheck est relancé après cette garde de cycle de vie; aucune vérification APNs/FCM, annulation distante ou route Bluetooth sur appareil réel n'a été effectuée.

## États, permissions et commandes Web accessibles

L'espace Web distingue le chargement, les listes vides, l'échec de lecture et l'absence de réseau; les commandes principales reçoivent un indicateur de focus clavier et des noms explicites. L'accès au microphone est demandé au clic sur Appeler, avant de créer une intention; un refus indique où le réactiver. Les couleurs de texte et d'action ajoutées ont été calculées avec des rapports de contraste d'au moins 4,5:1 sur leur fond contrôlé. TypeScript Web et le build Vite de production passent. Aucun essai au lecteur d'écran ni recette visuelle complète n'a été fait.

## Logs API et worker

Les événements métier relient `requestId`, organisation/ligne, identifiants d'appel ou de message et IDs Twilio. L'API conserve un `x-request-id` entrant seulement s'il s'agit d'un UUID, et masque cet en-tête dans les logs. Le worker lie ses reprises à `workerId`, `jobId` (ID persistant de jambe/appel ou message), organisation et SID fournisseur. Le code courant omet numéros, identités d'appareil, contenu SMS, tokens et messages d'exception; il ne garde que les codes fournisseur numériques et des codes internes contrôlés. Le runbook précise les champs et les accès à restreindre dans l'hébergeur. Vérification effectuée par revue statique du code et par les typechecks API/worker ci-dessous; aucun événement fournisseur réel ni test de fuite de journal n'a été exécuté.

Chaque webhook mesure la durée côté API et journalise son code HTTP et sa classe de résultat; les signatures manquantes/invalides ont une raison générique, sans valeur de signature. Le callback voix journalise aussi le délai depuis l'horodatage fournisseur. Le worker relève le volume exact des travaux dus, l'âge de l'élément dû le plus ancien et les demandes en revue manuelle (lot visible jusqu'à 20), puis trace la durée de cycle. Ces événements peuvent être agrégés par le collecteur de logs de l'hébergeur; aucune règle d'alerte ni aucun collecteur distant n'est configuré. Les erreurs internes de mise à jour de présence appareil sont journalisées, mais les échecs du SDK Voice côté client ne sont pas encore centralisés.

## Vérification des variables et des bundles clients

Les variables privées sont validées côté API au démarrage; le worker refuse de démarrer sans les credentials serveur requis. Les sources Web/Mobile n'utilisent que les préfixes publics adaptés aux clients et ne référencent pas de secret Supabase privilégié ni de secret Twilio. Les exports Web/Mobile présents au moment de la revue n'ont pas de source maps; la comparaison automatisée avec les valeurs non vides de l'environnement local n'y trouve aucun credential serveur (aucun n'est configuré dans cet environnement). `.env` est ignoré par Git. Cette vérification statique ne remplace pas une nouvelle analyse des artefacts après configuration des secrets de démo.

## Passe finale après mise à jour des états et du cycle mobile

- `tsc --noEmit` : Contracts, API, Web, Mobile et Worker passent.
- `vite build` : bundle de production Web créé.
- `expo export --platform all` : bundles Hermes iOS et Android créés avec Metro.
- Les typechecks API et Worker passent après l'ajout des journaux corrélés et le filtrage des codes d'erreur.
- Aucun test unitaire/intégration, appel ou SMS n'a été lancé pendant cette passe.

## Vérification des diagnostics et du mode maintenance

- `./node_modules/.bin/tsc -p apps/api/tsconfig.json` : passe; build API actualisé.
- `./node_modules/.bin/tsc -p apps/worker/tsconfig.json --noEmit` : passe.
- `./node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit` : passe.
- `./node_modules/.bin/tsc -p apps/mobile/tsconfig.json --noEmit` : passe.
- Le mode `OPERATIONS_PAUSED` et le code `503 operations_paused` ont été vérifiés par revue statique, pas par requête runtime.
- Après l'instrumentation client bornée : build TypeScript API, puis typechecks Worker, Web et Mobile passent à nouveau.
- Les quatre commandes ciblées viennent d'être relancées avec le runtime Node 24.19.0 fourni par l'environnement; le patch 24.21.0 est épinglé pour `.nvmrc`/CI mais n'est pas installé localement.
- `expo export --platform all`, exécuté avec Node 24.19.0, a généré les bundles Hermes Android et iOS (2,3 Mo chacun). Cela ne constitue pas un build natif signé.
- Le build Vite Web passe aussi avec Node 24.19.0; les exports Web et Mobile inspectés ne contiennent ni nom de variable serveur privilégiée, ni secret serveur configuré, ni source map.
- Aucun test unitaire, appel ou SMS n'a été lancé.

Les tests unitaires du tableau initial n'avaient pas été relancés après les changements couverts par les paragraphes précédents; ils viennent d'être relancés avec les scénarios contractuels SMS ci-dessous. Les essais de compte, d'appareil et d'opérateur n'ont pas été effectués.

## Advisories Supabase

- Sécurité : l'analyse en ligne signale 4 fonctions `SECURITY DEFINER` exécutables par `authenticated` (`issue_call_intent`, `prepare_outbound_message`, `list_pending_outbound_messages` et `set_device_voice_state`). Elles sont intentionnelles pour leurs opérations serveur, ont des privilèges ciblés et contrôlent les droits dans leur corps; ce sont des points à garder sous revue. `message_reconciliation_tasks` a RLS sans politique cliente afin qu'aucun rôle client ne lise la file; `service_role` l'utilise côté worker.
- Les politiques de `memberships` utilisent uniquement `auth.uid()` et le statut du membre; elles ne relisent pas `memberships` depuis leur propre politique. Les autres politiques qui vérifient l'appartenance peuvent donc interroger cette table sans récursion RLS. Les essais multi-organisation directs restent à exécuter avec deux comptes autorisés.
- Performance : 35 index encore jamais utilisés sur la base de démonstration vide, dont les index récents de séquence et de reprise; aucun n'a été supprimé avant d'observer une charge réelle. L'avis de clé étrangère non indexée sur la file SMS a été corrigé. L'avis informatif de capacité Auth fixe à 10 connexions reste à examiner avant une montée en charge.

## Limites de cette recette

La [matrice de support des plateformes](platform-support-matrix.md) sépare les builds produits des plateformes réellement testées. Aucune plateforme mobile ou native n'est déclarée validée pour distribution sur la seule base d'un export JavaScript.

- Le shell hôte fournit Node 26.0.0; l'environnement de travail propose aussi Node 24.19.0, utilisé pour les typechecks ciblés. La version exacte épinglée Node 24.21.0 n'est pas installée localement; la CI est configurée sur ce patch.
- L'export Expo est un bundle JavaScript, pas un build installable/signé.
- La machine n'a pas Xcode complet, simulateur iOS, Android SDK/ADB ni un JDK récent; aucun appareil physique n'était connecté.
- Aucune ligne, aucun utilisateur Supabase et aucun credential Twilio valide n'étant configuré, aucun appel ni SMS réel n'a été initié.
- Le dépôt `Samsooon76/on-on` a été fourni, mais sa résolution réseau échoue, la session `gh` est invalide et `.git` est en lecture seule; aucun service Railway Onoff n'a été créé ni publié.

## Vérification des contrats Fastify et des permissions Supabase — 25 septembre

| Vérification | Résultat |
|---|---|
| API typecheck/build sous Node 24.19.0 | Passent après ajout du compilateur Zod et des schémas de réponses JSON `/v1` |
| Tests API sous Node 24.19.0 | 26 réussis, 0 échec; en plus de la santé, de l'authentification, de CORS et des webhooks non signés, dix scénarios `POST /v1/messages` injectent Supabase et Twilio simulés pour vérifier le succès, les contenus français/Unicode longs, le refus de ligne non autorisée, le refus de destinataire exact et de préfixe pays, le refus définitif fournisseur, le timeout incertain, le rejeu sans second envoi, un callback anticipé et un callback dupliqué; deux tests vérifient l'isolation de l'historique; deux tests vérifient que seuls les admins peuvent affecter/révoquer une ligne via le repository privilégié |
| Dépendance du pont Zod | `@fastify/type-provider-zod@1.0.0`, Fastify 5.12.5, Zod 4.5.4; versions et lockfile épinglés |
| Contrats de sortie | Les routes API JSON ont une liste de champs sérialisés; les webhooks TwiML/XML et les réponses 204 conservent leur format sans corps JSON |
| Relance monorepo après restauration des dépendances verrouillées | `pnpm test`, `pnpm lint`, `pnpm typecheck` et `pnpm build` passent sous Node 24.19.0 avec pnpm 11.9.0; les 29 tests non vides réussissent à cette date. Une première tentative sous Node 26 a été interrompue avant les tests, car ce runtime ne correspond pas aux engines déclarés |
| Supabase hébergé `onoffv2` | 25 migrations jusqu'à `20260925152637_restore_guarded_user_rpc_access`; 19/19 tables publiques ont RLS |
| RPC métier authentifiés | Les quatre fonctions restent exécutables par `authenticated`, comme exigé par le JWT utilisateur transmis par les routes API; `anon` et `PUBLIC` ne sont pas accordés. Leurs contrôles d'identité, d'appartenance et d'affectation restent dans les fonctions SQL |

La suite de tests API ne valide pas un vrai compte, Twilio ni le routage multi-appareils. Les commandes de validation du monorepo passent, mais aucun appel ou SMS réel n'a été initié.

## Isolation multi-organisation sur Supabase distant — 25 septembre

La suite `supabase/tests/rls_isolation.test.sql` a été exécutée sur la branche distante temporaire `codex-rls-isolation-20260925` (`sjrsujghkzouceuhegbz`), créée sans données de production depuis le projet hébergé `onoffv2`. Les neuf assertions pgTAP réussissent: le rôle `authenticated` avec l'identité A ne voit que l'organisation, l'appartenance, la ligne, les contacts, appels, conversations et messages de A; `provider_events` n'est pas directement lisible et `anon` ne lit pas les contacts. Le script crée deux utilisateurs et leurs affectations dans la branche, puis annule toutes les fixtures par `ROLLBACK`. La branche a ensuite été supprimée et son absence confirmée; le test n'a modifié ni le schéma ni les données de l'instance partagée. Cette simulation du contexte JWT Postgres ne remplace pas un appel HTTP avec deux vrais JWT Supabase.

La frontière fournisseur de `createApp` accepte des clients Supabase et SMS injectés par les tests. Les scénarios contractuels ci-dessus utilisent cette frontière et ne font aucun appel réseau. Le workflow CI exécute la suite via `pnpm test`.

Le scénario du callback anticipé a révélé que la réponse HTTP pouvait renvoyer `submitting` après que la base avait déjà enregistré `delivered`. La route renvoie désormais le statut projeté par `update_outbound_message_result`, ce qui préserve un état terminal reçu avant la réponse Twilio.

Après cette correction, l'API compile et ses 17 tests passent sous Node 24.19.0. Le typecheck Mobile passe après le blocage des sélecteurs durant l'appel; le typecheck Worker passe après l'arrêt interruptible de son délai de polling. Ces vérifications restent distinctes des essais natifs et réels.

Une nouvelle lecture des catalogues PostgreSQL sur Supabase hébergé confirme RLS activée sur les 19 tables `public` et aucun droit `SELECT` pour `anon`. Sur les 16 fonctions `SECURITY DEFINER` publiques, seules les quatre opérations gardées par identité/droits (`issue_call_intent`, `prepare_outbound_message`, `list_pending_outbound_messages`, `set_device_voice_state`) sont exécutables par `authenticated`; les douze autres sont réservées à `service_role`.

La suite pgTAP `supabase/tests/rls_isolation.test.sql` passe avec ses neuf assertions sur une branche Supabase distante isolée, sans données de production. Elle vérifie l'isolation des données de A face aux fixtures de B et les refus de lecture des événements fournisseur et des contacts par `anon`. La transaction annule les fixtures et la branche temporaire est supprimée. Cela valide le contexte Postgres simulé dans la suite; des requêtes HTTP avec deux vrais JWT restent à effectuer.

Après l'ajout du contrôle d'affectation admin, `CI=true pnpm test`, `pnpm lint`, `pnpm typecheck` et `pnpm build` passent à nouveau sous Node 24.19.0 et pnpm 11.9.0 : 33 tests réussis (3 contrats, 4 API client, 26 API). Les tests SQL (21 assertions) pour le RPC d'affectation sont écrits mais attendent l'autorisation de créer une branche Supabase à 0,01344 $/heure. Les suites Web, Worker et adaptateurs vocaux sont encore vides. Expo natif, Twilio, comptes réels et déploiement hébergé ne sont pas couverts.
