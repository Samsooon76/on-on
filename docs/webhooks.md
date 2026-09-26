# Webhooks clients

Les webhooks clients envoient un `POST` JSON signé à votre serveur lorsque le produit enregistre un événement. Ils sont configurables dans **Réglages → API & webhooks**. Leur configuration exige un administrateur actif. Un abonnement couvre les lignes de son organisation et les événements sélectionnés.

## Configuration

1. Déployez une URL publique HTTPS sur le port 443, avec un certificat valide. Les URL privées, identifiants dans l’URL et fragments sont refusés. Les redirections ne sont pas suivies.
2. Ajoutez l’URL et les événements depuis les réglages, ou appelez `POST /v1/organizations/{orgId}/webhooks`.
3. Copiez le secret `whsec_…` affiché une seule fois dans la réponse de création. Il sert à vérifier la signature, avec son préfixe inclus.
4. Installez le secret côté serveur, puis **Envoyer un test**. Un `webhook.test` est mis en file et apparaît dans les livraisons.
5. Actualisez les livraisons pour voir l’état, le nombre de tentatives et le code HTTP.

```sh
curl "$API_BASE/v1/organizations/$ORG_ID/webhooks" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"description":"Mon CRM","url":"https://crm.example.com/webhooks/onoff","events":["sms.received","call.received","call.connected","call.ended","user.status_changed"]}'
```

Réponse `201` : `{ id, description, url, events, enabled, createdAt, secret }`. Une liste ne restitue jamais le secret. Maximum : 10 abonnements par organisation. Pour changer l’URL ou les événements, créez un nouvel abonnement puis supprimez l’ancien ; dédupliquez les événements pendant le chevauchement.

## Catalogue

| Type | Quand ? | `data` |
| --- | --- | --- |
| `sms.received` | SMS entrant enregistré. | Message |
| `sms.sent` | Message sortant passé à `sent`. | Message |
| `sms.delivered` | Livraison confirmée. | Message |
| `sms.failed` | Passage à `failed` ou `undelivered`. | Message |
| `call.received` | Appel entrant créé, avant une éventuelle réponse IVR. | Appel |
| `call.started` | Appel sortant créé après consommation de l’intention. | Appel |
| `call.connected` | Première valeur de `answered_at` : connexion au correspondant/agent enregistrée. L’accueil IVR seul ne suffit pas. | Appel |
| `call.ended` | Première valeur de `ended_at`, quelle que soit l’issue de l’appel. | Appel |
| `call.missed` | Fin d’un appel entrant sans connexion, y compris un échec ou une annulation avant réponse. Émis en complément de `call.ended`. | Appel |
| `voicemail.received` | Message vocal et enregistrement disponibles en base. | Message vocal |
| `user.status_changed` | Création d’un membre ou modification de son rôle/statut. | Utilisateur |
| `user.reachability_changed` | Changement de disponibilité observé dans l’application. | Disponibilité |
| `webhook.test` | Test explicite ; ne nécessite pas d’abonnement à ce type. | `{ "message": "Test de votre webhook Onoff." }` |

La disponibilité de l’application est `available` si un appareil est inscrit pour la voix, `busy` si une réservation ou un appel est actif, `offline` autrement ou si le compte est suspendu/révoqué. Elle est échantillonnée par le worker ; le premier relevé sert de référence sans événement. Les transitions plus courtes que l’intervalle d’échantillonnage peuvent être regroupées. L’expiration silencieuse d’un navigateur est détectée après 90 secondes sans inscription, au relevé suivant. Une inscription mobile persiste pour le push jusqu’à révocation/déconnexion. Ce statut ne décrit ni l’activité TaskRouter (pause/disponible dans les files) ni un renvoi externe.

## Enveloppe et données

```json
{
  "id": "c180efec-bd26-4c6c-8053-5d85d39f2956",
  "type": "call.connected",
  "apiVersion": "v1",
  "createdAt": "2026-09-26T12:00:00+00:00",
  "organizationId": "10000000-0000-4000-8000-000000000001",
  "data": {
    "id": "20000000-0000-4000-8000-000000000001",
    "lineId": "30000000-0000-4000-8000-000000000001",
    "direction": "inbound",
    "remoteNumber": "+33612345678",
    "status": "answered",
    "startedAt": "2026-09-26T11:59:55+00:00",
    "answeredAt": "2026-09-26T12:00:00+00:00",
    "endedAt": null,
    "durationSeconds": null
  }
}
```

`id` est l’identifiant de l’événement, stable pendant toutes les tentatives et relances. `data.id` identifie la ressource. `createdAt` indique l’enregistrement de l’événement dans Onoff ; les horodatages métier figurent dans `data`. Une réconciliation tardive peut produire un événement après l’action réelle. `data` est un instantané ; relisez l’API pour connaître l’état actuel.

Champs de `data` :

- **Message** : `id`, `conversationId`, `lineId`, `remoteNumber`, `direction` (`inbound`/`outbound`), `body`, `status`, `createdAt`, `sentAt`, `deliveredAt`, `errorCode`. Les trois derniers champs sont nullables. Le texte du SMS est inclus.
- **Appel** : `id`, `lineId`, `direction`, `remoteNumber`, `status`, `startedAt`, `answeredAt`, `endedAt`, `durationSeconds`. Les quatre derniers champs sont nullables. `remoteNumber` peut être une identité masquée au lieu d’un numéro E.164.
- **Message vocal** : `id`, `callId`, `lineId`, `durationSeconds`, `createdAt`. Aucun lien audio public ; l’accès aux enregistrements garde l’authentification du produit.
- **Utilisateur** : `userId`, `status` (`active`/`suspended`/`revoked`), `previousStatus`, `role` (`admin`/`member`), `previousRole`. Les valeurs précédentes sont nulles à la création.
- **Disponibilité** : `userId`, `status`, `previousStatus`, parmi `available`, `busy`, `offline`.

Les schémas complets sont dans `components.schemas.WebhookEvent` de `/openapi.json`. Les identifiants Twilio et les paramètres de routage internes sont exclus.

## Signature et réception

En-têtes :

```text
Content-Type: application/json
X-Onoff-Event-Id: <event.id>
X-Onoff-Delivery-Id: <delivery.id>
X-Onoff-Attempt: 1
X-Onoff-Signature: t=1790424000,v1=<HMAC SHA-256 hex>
```

Le HMAC utilise le secret complet comme clé UTF-8 et signe `timestamp + "." + corps_JSON_brut`. Vérifiez **avant** le parsing JSON, avec une comparaison en temps constant, et rejetez les timestamps éloignés de plus de 300 secondes dans le passé ou le futur. La signature et son timestamp changent à chaque tentative. Synchronisez l’horloge du récepteur.

L’exemple [verify-signature.mjs](../examples/webhooks/verify-signature.mjs) est testé contre les altérations du corps et les dates hors fenêtre. Le [serveur de réception Node.js](../examples/webhooks/receiver.mjs) vérifie aussi l’organisation et enregistre l’événement dans PostgreSQL avant de répondre `204` :

1. Dans votre application, installez `pg` et copiez `receiver.mjs`, `verify-signature.mjs` et [inbox.sql](../examples/webhooks/inbox.sql).
2. Exécutez `inbox.sql` dans une base privée à votre application.
3. Configurez `DATABASE_URL`, `ONOFF_WEBHOOK_SECRET` et `ONOFF_ORGANIZATION_ID` côté serveur.
4. Lancez `node receiver.mjs` derrière votre reverse proxy HTTPS vers `127.0.0.1:3001`.
5. Faites traiter les lignes `processed_at IS NULL` par votre propre worker métier. Celui-ci doit aussi rendre ses effets idempotents : un arrêt après une action externe peut nécessiter une nouvelle tentative.

La clé primaire `event_id` de l’exemple gère la déduplication durable. Un simple `Set` en mémoire ne survit pas aux redémarrages.

## Livraison, reprises et exploitation

- L’événement et ses livraisons sont enregistrés dans la transaction du changement métier. Un rollback n’émet aucun événement. Un callback identique sans transition ne crée pas un second événement.
- Un worker indépendant envoie les requêtes, avec quatre livraisons concurrentes par instance et une pause de 5 secondes entre les lots. La latence dépend de la file ; il n’y a pas de garantie de temps réel.
- Répondez `2xx` en moins de 5 secondes après une persistance durable. Tout autre HTTP, erreur DNS/TLS/réseau ou timeout est un échec. Les réponses clientes ne sont pas conservées et les redirections ne sont pas suivies.
- Au maximum **8 tentatives** par cycle : première tentative, puis délais minimaux de **30 s, 2 min, 10 min, 30 min, 2 h, 6 h et 24 h**. Une interruption du worker utilise aussi une tentative ; sa réservation expire après 60 secondes.
- Après épuisement, la livraison est `failed` et peut être relancée manuellement avec le même événement. La relance remet le compteur à zéro. Un test et une relance sont limités à une fois par minute, respectivement par endpoint et par livraison.
- La livraison est **au moins une fois** dans la fenêtre de reprises. Les doublons et changements d’ordre sont possibles ; aucune livraison n’est garantie si votre serveur reste inaccessible. Une relance ou un second endpoint peut recevoir un événement déjà traité.
- Historique et contenu conservés **7 jours** à partir de la création de l’événement, puis supprimés par le worker. La relance ne prolonge pas cette durée. Les 50 livraisons les plus récentes sont consultables par endpoint.
- Suspendre ou supprimer un endpoint annule sa file en attente. Les livraisons déjà en cours peuvent encore arriver. Réactiver reprend uniquement les futurs événements ; aucun rattrapage de la période suspendue.
- Si le créateur perd son rôle administrateur actif, ou si l’organisation est suspendue, l’envoi s’arrête et les livraisons encore en attente sont annulées lors du prochain passage du worker. Un autre administrateur peut recréer un abonnement à son nom.
- Renouveler le secret invalide immédiatement l’ancien pour les nouvelles tentatives. Une requête déjà partie peut encore utiliser l’ancien ; coordonnez la rotation avec le récepteur.

## API de gestion

Préfixe : `/v1/organizations/{orgId}/webhooks`. Authentification : session utilisateur, rôle administrateur actif.

| Méthode et suffixe | Corps | Résultat |
| --- | --- | --- |
| `GET /` | — | `200 { items }` |
| `POST /` | `{ description, url, events }` | `201` endpoint + secret affiché une fois |
| `PATCH /{id}` | `{ enabled: false }` ou `true` | `200` endpoint |
| `DELETE /{id}` | — | `204` |
| `POST /{id}/rotate-secret` | — | `200 { secret }` |
| `POST /{id}/test` | — | `202 { eventId }` |
| `GET /{id}/deliveries` | — | `200 { items }` |
| `POST /{id}/deliveries/{deliveryId}/retry` | — | `202 { eventId }`, uniquement si `failed` |

Les livraisons exposent `id`, `eventId`, `eventType`, `status`, `attempts`, `httpStatus`, `lastError`, `createdAt`, `nextAttemptAt`, `deliveredAt`. `status` : `pending`, `sending`, `delivered`, `failed`, `canceled`. Les erreurs sont des codes courts sans corps reçu ni secrets.

## Activation de l’instance (équipe produit)

1. Appliquer la migration `20260926155412_customer_webhooks.sql` au projet Supabase ciblé, après revue.
2. Générer une clé serveur : `openssl rand -base64 32`. La configurer sous `WEBHOOK_ENCRYPTION_KEY`, avec **la même valeur sur l’API et le worker**. Les secrets des endpoints sont chiffrés AES-256-GCM en base. Ne pas remplacer cette clé sans rechiffrer les secrets existants.
3. Déployer l’API, le web et le worker. Le worker existant requiert aussi les credentials Supabase et Twilio configurés. La documentation publique reste accessible quand les webhooks sont désactivés.
4. Créer un endpoint de test, configurer son secret sur le récepteur et vérifier un `webhook.test` livré. Simuler ensuite un `503`, constater la reprise, puis un `204`.
5. Suivre les logs `task=customer_webhooks` et les livraisons en échec. Les réponses, contenus SMS, URL et secrets ne sont pas journalisés par le worker.

La résolution DNS est refaite avant chaque livraison et l’adresse publique validée est fixée pour la connexion TLS. Les tables et RPC sont accessibles au rôle serveur uniquement ; l’API vérifie l’organisation et le rôle avant lecture, et les mutations les revérifient en transaction.

Références d’implémentation : [triggers PostgreSQL](https://supabase.com/docs/guides/database/postgres/triggers), [isolation RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
