# API HTTP v1

Politique d'évolution et versions minimales : [compatibilité API et clients](api-compatibility.md).

L'API écoute sur le port configuré par `API_PORT` (4100 par défaut). Les routes `/v1/*` exigent `Authorization: Bearer <Supabase access token>`. Les erreurs ont une forme stable `{ code, message, requestId }`. Les routes utilisateur sont sous `/v1`; les webhooks fournisseur sous `/webhooks/twilio`.

Les corps JSON `/v1` et leurs réponses sont décrits avec les schémas Zod centralisés dans `apps/api/src/response-schemas.ts`, branchés aux validateurs et sérialiseurs Fastify. Les sérialiseurs n'émettent que les champs prévus par contrat. Les réponses sans corps (`204`) et le TwiML XML des webhooks gardent leurs contrats HTTP spécifiques.

Le paquet `@onoff/api-client` fournit au Web et au mobile l'ajout du jeton injecté, le format des paramètres paginés, les erreurs métier structurées, l'identifiant de corrélation et le support d'annulation via `AbortSignal`. Il ne réessaie pas les mutations; chaque action à effet externe conserve sa clé d'idempotence créée par l'interface.

## Santé et session

- `GET /health/live` et `GET /health/ready`; les deux réponses exposent `version`, lu depuis `apps/api/package.json` (version actuelle `0.1.0`).
- `GET /v1/me`, `GET /v1/organizations`, `GET /v1/organizations/:orgId/lines`
- `GET /v1/services` retourne la configuration effective (`voiceEnabled`, `smsEnabled`, `administrationEnabled`, `numberPurchaseEnabled`, `operationsPaused`, `pauseMessage`). Route authentifiée, sans cache ni secrets ; la disponibilité réseau du fournisseur n’est pas garantie par ces indicateurs. Déployer l’API avant le web qui les consomme.
- `GET /v1/organizations/:orgId/number-offers?country=FR`, `POST /v1/organizations/:orgId/number-orders` et `GET /v1/organizations/:orgId/number-orders` : achat Twilio réservé aux administrateurs, tarif confirmé, attribution au compte connecté et reprise sans nouvel achat. Voir [le parcours de commande](runbooks/number-provisioning.md).
- `PUT` and `DELETE /v1/organizations/:orgId/lines/:lineId/assignments/:userId` require an active organization admin. Updates validate the target membership and line capabilities in a service-only transaction; revocation is soft, idempotent, and audited.
- `GET /v1/organizations/:orgId/contacts?limit=&cursor=&q=` et `POST /v1/organizations/:orgId/contacts`. `q` recherche un nom, un email contenant `@` ou un numéro complet normalisé. Une recherche par numéro conserve tous les téléphones du contact dans la réponse.
- `GET/PATCH/DELETE /v1/contacts/:id` (suppression logique / archivage)
- `GET/POST /v1/devices`, `PUT /v1/devices/:id/voice-state`, `POST /v1/devices/:id/revoke`
- `POST /v1/voice/token`, `POST /v1/call-intents`, `GET /v1/lines/:lineId/calls?limit=&cursor=`
- `POST /v1/call-intents/:id/cancel` annule une intention encore inutilisée et libère sa réservation; une intention déjà consommée reste liée à l'appel en cours.
- `GET /v1/lines/:lineId/conversations?limit=&cursor=` renvoie le correspondant, le dernier message et `unread` calculé avec l'état de lecture personnel; `GET /v1/conversations/:id/messages?limit=&cursor=` renvoie l'historique autorisé.
- `GET /v1/messages/pending` restaure pour l'utilisateur ses SMS encore incertains et leur clé de reprise, avec contrôle de ses affectations actives.
- `PUT /v1/conversations/:id/read` enregistre le dernier message lu par l'utilisateur.
- `POST /v1/diagnostics/voice` accepte uniquement une catégorie d'échec de registration ou de rafraîchissement d'historique, la plateforme, la version applicative et une durée bornée. L'API limite le débit à 10 événements par utilisateur sur 5 minutes; aucun message d'erreur libre ni identifiant d'appel n'est enregistré.
- `POST /v1/messages` crée un message idempotent; `POST /v1/call-intents` prépare un nouvel appel. Quand `OPERATIONS_PAUSED=true`, ces deux routes répondent `503 operations_paused` avec le message de maintenance configuré. Le client affiche ce message. Cette pause bloque les nouvelles créations et ne termine pas les appels déjà actifs.

## Webhooks Twilio

- `POST /webhooks/twilio/voice/outbound` (TwiML App)
- `POST /webhooks/twilio/voice/inbound` (numéro voix entrant)
- `POST /webhooks/twilio/voice/status` et `POST /webhooks/twilio/voice/dial-action`
- `POST /webhooks/twilio/messages/inbound` et `POST /webhooks/twilio/messages/status`

Tous les webhooks valident `X-Twilio-Signature` sur l'URL publique exacte et le corps URL-encodé avant d'appliquer un effet. Les événements sont idempotents et les payloads reçus ne sont pas retournés aux clients.

Les callbacks voix stockent l'horodatage Twilio et son numéro de séquence séparément de l'heure de réception serveur. Une séquence plus ancienne pour un même `CallSid` est conservée comme ignorée; aucune séquence globale n'est supposée entre jambes différentes. Les corps bruts complets ne sont pas conservés.

Les listes utilisent un curseur stable; le client peut demander jusqu'à 100 lignes par page. Toute action à effet externe exige une clé `Idempotency-Key`. Les réponses excluent les colonnes internes et les valeurs confidentielles. Realtime émet des invalidations privées ciblées, sans contenu de message; le client relit l'état via ces routes.

L'historique d'appels et la liste des conversations peuvent inclure `remoteContactName` lorsque le numéro correspond à un seul contact actif autorisé. Le numéro historique reste inchangé; les correspondances ambiguës conservent l'affichage du numéro.

Pour un SMS, le client réutilise la même clé pendant la vérification et verrouille son brouillon si le résultat reste incertain. La clé demeure conservée tant qu'aucun SID Twilio n'est connu; le client la récupère après reconnexion par `GET /v1/messages/pending`. Après confirmation fournisseur ou échec définitif, elle est retenue 24 heures puis expire. La création d'une ressource Message Twilio ne documente pas de clé d'idempotence; l'application ne prétend donc pas garantir « exactement une fois » après un timeout. Le worker relit l'état par SID ou signale un cas sans SID pour intervention; il ne crée jamais un remplacement automatiquement.

Le plafond quotidien de démonstration compte chaque SMS persisté avant la création Twilio, y compris une création refusée clairement par le fournisseur. Le statut passe alors à `failed`; le quota n'est pas restitué afin qu'une rafale de refus suivis de reprises ne contourne pas le garde-fou. Un refus de droits ou de plafond avant cette préparation ne compte pas.

Les interfaces affichent une estimation GSM-7 ou Unicode et du nombre de segments; la segmentation réelle varie selon l'encodage final et le canal. Les limites usuelles documentées sont 160/153 unités GSM-7 et 70/67 unités UCS-2 pour un SMS simple/concaténé. [Limites et calcul des segments SMS](https://www.twilio.com/docs/glossary/what-s-sms-character-limit).

Un seul onglet du profil navigateur inscrit l'appareil web pour la voix, grâce à [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API); le verrou est transféré au prochain onglet quand le propriétaire se ferme. La présence est renouvelée toutes les 30 secondes et expire du routage après 90 secondes sans renouvellement. Web Locks exige une origine sécurisée et ne coordonne que les onglets de la même origine; sans cette API, l'interface désactive la voix et l'explique.

Un mobile annonce son identité native après `Voice.register`; cette inscription reste ciblable en arrière-plan grâce au push jusqu'à déconnexion/révocation. Sans le SID APNs/FCM de sa plateforme, l'API n'annonce pas les appels entrants natifs comme disponibles. Railway fournit `PORT`; si `API_PORT` est absent l'API utilise ce port (4100 en développement local).
# Limites d'exploitation

- L'API impose des fenêtres atomiques partagées entre instances : 30 émissions de token vocal/minute, 5 intentions d'appel/minute et 10 SMS/minute par utilisateur. Les quotas journaliers d'appels et de SMS restent appliqués par transaction SQL et organisation.
- TwiML limite un appel à `MAX_ACTIVE_CALL_SECONDS` (900 secondes par défaut). L'invitation entrante et la jambe sortante utilisent le même plafond.
- Le worker réconcilie les jambes voix actives à partir de leur état Twilio et du calendrier `call_legs.reconcile_after`; aucune tâche en mémoire n'est nécessaire pour retrouver un appel resté ouvert après redémarrage.
- Le résultat d'envoi SMS incertain n'est pas réémis automatiquement.
