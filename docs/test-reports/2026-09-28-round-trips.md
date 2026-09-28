# Allers-retours et chargement des conversations — 28 septembre 2026

## Constat de départ

Mesures publiques non authentifiées sur les services déployés : `/health/live` (aucun appel à Supabase) répond en 177 ms (médiane de 12 essais) alors que la connexion au point d'entrée Railway de Paris prend 10 ms; une requête qui déclenche un seul appel à Supabase Auth en coûte 356 ms. Un appel API → Supabase coûte donc environ 180 ms. Le conteneur API est probablement dans une région lointaine (à confirmer dans Railway; ce rapport ne modifie pas la région).

Chaque écran enchaînait plusieurs appels : liste des conversations 8, fil 6, historique d'appels 6, marquage lu 7, appareils 3. Une base en mémoire alimentée avec les migrations du dépôt (RLS active, 15 000 messages par organisation) exécute chacune de ces requêtes en 1 à 15 ms : le coût venait du nombre d'allers-retours, pas du SQL.

## Allers-retours par endpoint

Comptés en exécutant l'API compilée avec un faux client Supabase qui enregistre chaque appel réseau (la vérification locale du jeton n'en compte pas).

| Endpoint | Avant | Après | Durée estimée avant → après |
|---|---:|---:|---|
| `GET /v1/services` | 1 | 0 | 0,36 s → 0,18 s |
| `GET /v1/organizations`, `/lines`, `/contacts`, `/messages/pending` | 2 | 1 | 0,54 s → 0,36 s |
| `GET /v1/devices` | 3 | 1 | 0,72 s → 0,36 s |
| `GET /v1/lines/{ligne}/calls` | 6 | 1 | 1,26 s → 0,36 s |
| `GET /v1/lines/{ligne}/conversations` | 8 | 1 | 1,62 s → 0,36 s |
| `GET /v1/conversations/{id}/messages` | 6 | 1 | 1,26 s → 0,36 s |
| `PUT /v1/conversations/{id}/read` | 7 | 2 (dont la vérification d'une écriture) | 1,44 s → 0,54 s |

Les durées sont calculées (177 ms + 180 ms × nombre d'appels, depuis Paris, région API inchangée), pas chronométrées sur le service déployé.

Démarrage à froid du Web, données nécessaires à la boîte : 0,54 + 0,72 + 1,62 ≈ 2,9 s avant, 0,36 × 3 ≈ 1,1 s après. Avec le dernier état mémorisé, la boîte s'affiche sans attendre le réseau.

## Statistiques

La lecture par lots de 100 appels était séquentielle (environ 4 allers-retours par lot) : 46 allers-retours séquentiels pour 1 000 appels sur la période, 130 pour 3 000, soit ~8,4 s et ~23 s avec 180 ms par appel. Passé 10 s de traitement, l'API coupe la connexion (`UND_ERR_SOCKET` vérifié avec la configuration `connectionTimeout`). Après : appels, files, appareils de l'organisation et instantané sont lus ensemble, puis six lots à la fois : 8 pour 1 000 appels, 18 pour 3 000 (calcul; l'appel réel a été vérifié avec un faux Supabase à latence simulée).

## SQL

Données synthétiques dans PGlite (Postgres compilé en WASM : ordres de grandeur, pas des temps de production). Volume multiplié par 1, 4 puis 10 :

| Fonction | Avant | Après |
|---|---|---|
| `list_pending_outbound_messages()` (à chaque démarrage) | 6,8 → 16,5 → 35,9 ms, pour 0 ligne retournée | 0,4 ms, indépendant du volume |
| `latest_conversation_messages` (51 conversations) | 12,5 → 14,4 → 36,9 ms | 2,5 → 2,3 → 2,5 ms |
| `list_line_conversations` (page de 30) | — | 12 → 15 ms pour 250 conversations; 15,8 ms pour 2 000 |

Ligne extrême (60 000 conversations, 180 000 appels, un fil de 20 000 messages), mêmes outils :

| Fonction | Ancien code | Après |
|---|---|---|
| Dernier message de 31 conversations | 93 ms | 2,3 ms |
| Historique d'appels (page de 30) | — | 1,8 ms (81 ms avant correction de la relecture) |
| Fil (page de 50) | 1,8 ms (requête isolée) | 2,9 ms (53 ms avant correction de la relecture) |
| Liste des conversations (page de 30) | ~120 ms (dernier message + non-lus) | 30 ms, dont 26 ms de non-lus (fonction existante non modifiée) |

`list_pending_outbound_messages` relisait tous les messages des lignes de l'utilisateur : la jointure `message.id::text = …` n'est pas indexable. Les réécritures gardent signature et résultats; les tests SQL comparent les deux implémentations sur le même jeu de données.

## Vérifications

- API : 167 tests, dont l'authentification avec une vraie paire de clés ES256 (jeton falsifié, expiré, rôle ou audience incorrects, anonyme, jeton symétrique historique, JWKS indisponible, écritures qui gardent l'appel à Auth), les routes réécrites (un seul appel base par écran, 404 sans droit, 503 sur erreur ou réponse inattendue) et un test d'intégration où l'API réelle appelle les vraies fonctions SQL (pagination sans trou ni répétition, précision à la microseconde, isolation entre organisations, état de lecture). Sans l'arrondi corrigé du curseur, ce test échoue : une conversation était sautée à la limite de deux pages.
- Relecture indépendante (API, SQL, statistiques, web) : aucun bloquant. Corrigé à sa suite : lectures via clé de service qui acceptaient une session révoquée (la vérification locale est limitée à une liste de routes protégées par la RLS seule), refus à tort d'un jeton valide quand le point de clés répondait 403/429, identifiants d'utilisateur non v4, plans SQL en parcours de toute la ligne, fil mis en cache pouvant masquer des messages après une longue absence (Web et iOS), fil d'un autre SMS pouvant être mémorisé sous la conversation reprise, clichés locaux jamais purgés s'ils étaient illisibles ou d'un autre compte. Non traités : sept jours maximum de validité des jetons à confirmer dans Supabase, plafond des statistiques vers 8 000 appels, rechargements superflus après hydratation quand l'organisation change.
- SQL : `supabase/tests/conversation_loading.test.sql` (équivalence avec les anciennes fonctions, portée d'accès pour sept profils dont membre suspendu et affectation révoquée, règles explicites sans RLS, pagination avec égalité d'horodatage, état de lecture propre à chaque utilisateur). Sept mutations volontaires de la migration ont été introduites : six sont détectées, la septième est équivalente (la clé étrangère composite garantit déjà la cohérence d'organisation).
- iOS : 43 tests (18 nouveaux : cache des fils, chargement progressif, stockage du dernier état dans le trousseau avec écriture interrompue, autre utilisateur, échec du stockage). La logique de `App.tsx` iOS (chargement progressif, rafraîchissements ciblés, dernier état affiché au démarrage) n'a été que typée et relue : elle n'a été exécutée ni sur simulateur ni sur iPhone.
- Web : 75 tests; navigateur local contre une API simulée (400 ms par appel) :
  - démarrage à froid : trois niveaux de 400 ms, les appareils ne bloquent plus;
  - avec le dernier état mémorisé (latence simulée de 1,5 s par appel) : boîte et nom de l'organisation affichés à 0,6 s, avant la première réponse de l'API (2,0 s), lignes verrouillées seulement pendant la vérification des SMS en attente;
  - conversations affichées à 1,6 s sans attendre les appareils (3,8 s) ni les appels (4,1 s);
  - fil rouvert : 60 ms contre 1,26 s la première fois, avec actualisation silencieuse;
  - SMS à reprendre et échec de la vérification : mêmes comportements et même verrou qu'avant;
  - ligne mémorisée reprise après rechargement; déconnexion : le cliché est supprimé.

## Non vérifié

- Aucun appel authentifié sur les services déployés, aucune mesure sur iPhone. Les contrôles ont tourné avec le Node 26 de l'environnement (le projet déclare Node 24).
- La migration n'est pas appliquée à Supabase : à faire avant de déployer l'API (voir la [décision 006](../decisions/006-fewer-round-trips.md)).
- La suite `pnpm test:admin:db` complète échoue déjà sans ces changements sur `call_tags.test.sql` (la même suite passe fichier par fichier); cela n'est pas lié à cette intervention.
