# Intégrer l’API Onoff

La documentation consultable est servie par l’API sur **`/docs`**, avec une recherche par route et les schémas des requêtes et réponses. **`/openapi.json`** fournit OpenAPI 3.1, importable dans Postman ou un générateur de client. Le lien **Réglages → API & webhooks → Documentation API** ouvre la bonne instance.

## 1. Se connecter

Base de développement : `http://localhost:4100`. En production, utilisez l’origine HTTPS de votre instance, sans ajouter `/v1` à la base. Tous les endpoints clients commencent par `/v1/`.

Cette version utilise des **sessions utilisateur Supabase**. Elle ne fournit pas encore de clés API permanentes ni de flux OAuth REST pour les intégrations autonomes. Les jetons du connecteur MCP sont réservés à `/mcp` et sont refusés sur `/v1`.

Pour votre propre application, renseignez l’URL Supabase et sa clé **publique** fournies par l’administrateur de votre instance. Connectez l’utilisateur avec le SDK Auth. Exemple JavaScript :

```js
import { createClient } from '@supabase/supabase-js';

const auth = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const { data, error } = await auth.auth.signInWithPassword({ email, password });
if (error) throw error;
const accessToken = data.session.access_token;

const response = await fetch(`${API_BASE}/v1/me`, {
  headers: { Authorization: `Bearer ${accessToken}` },
});
if (!response.ok) throw new Error(`API : ${response.status}`);
const me = await response.json();
```

Utilisez la session renouvelée par le SDK, y compris pour les requêtes suivantes. Protégez le refresh token comme un mot de passe ; ne placez ni clé serveur Supabase, ni identifiants Twilio dans votre intégration cliente. Un `401` indique une session absente, expirée ou invalide. Pour une application web sur une autre origine, l’administrateur doit autoriser cette origine dans la configuration CORS de l’API.

Les champs retournés conservent leur casse réelle : par exemple `organization_id` pour une organisation dans `/v1/me`, mais `organizationId` dans le corps d’un envoi SMS. Le schéma OpenAPI est la référence.

## 2. Trouver son organisation et ses lignes

```sh
export API_BASE='https://votre-api.example.com'
# TOKEN = access_token de la session utilisateur, jamais une clé serveur.
curl "$API_BASE/v1/me" -H "Authorization: Bearer $TOKEN"
curl "$API_BASE/v1/organizations/$ORG_ID/lines" \
  -H "Authorization: Bearer $TOKEN"
```

`GET /v1/me` retourne `userId` et `organizations`. Choisissez `organization_id`. La liste des lignes retourne `items`, avec `can_voice`, `can_sms` et `lines`. Une ligne utilisable doit être affectée à l’utilisateur avec la permission correspondant à l’opération. L’administration d’une organisation ne remplace pas l’affectation requise pour émettre un SMS ou un appel.

`GET /v1/services` indique les services activés et une éventuelle suspension des nouvelles émissions.

## 3. Contacts et historique

| Action | Route |
| --- | --- |
| Rechercher | `GET /v1/organizations/{orgId}/contacts?q=Alice&limit=30` |
| Créer | `POST /v1/organizations/{orgId}/contacts` |
| Lire / modifier / archiver | `GET/PATCH/DELETE /v1/contacts/{id}` |
| Historique des appels | `GET /v1/lines/{lineId}/calls` |
| Conversations | `GET /v1/lines/{lineId}/conversations` |
| Messages | `GET /v1/conversations/{id}/messages` |
| Marquer comme lu | `PUT /v1/conversations/{id}/read` |

Création d’un contact :

```json
{
  "displayName": "Alice Martin",
  "email": "alice@example.com",
  "phones": [{ "phoneNumber": "+33612345678", "label": "Mobile" }]
}
```

Une modification `PATCH` utilise ces mêmes champs et la `version` reçue à la lecture. En cas de conflit, relisez le contact avant de réappliquer la modification.

Les listes paginées utilisent `{ "items": [], "nextCursor": null }`. Le nombre d’éléments demandé est `limit`, de 1 à 100 (30 par défaut). Tant que `nextCursor` n’est pas `null`, passez sa valeur inchangée dans `cursor` avec `URLSearchParams`. Une page courte n’est pas un signal de fin si un curseur est présent. Les listes sont demandées du plus récent au plus ancien ; les messages d’une page sont présentés dans l’ordre chronologique pour l’affichage.

## 4. Envoyer un SMS

```sh
curl "$API_BASE/v1/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 054efdda-e04c-4fef-936d-2c418fc49b24' \
  -d '{"organizationId":"ORG_UUID","lineId":"LINE_UUID","destination":"+33612345678","body":"Votre rendez-vous est confirmé."}'
```

Les numéros utilisent E.164 (`+` et indicatif). Le texte contient de 1 à 1 600 caractères après suppression des espaces aux extrémités.

- `201` : soumission confirmée, avec `id`, `conversationId` et `status`.
- `202` : soumission en cours ou incertaine. Vérifiez avec **la même clé et le même corps**. `GET /v1/messages/pending` retrouve les messages incertains de l’utilisateur et leur clé.
- `422` : refus fournisseur confirmé ; le message est en échec.
- `sent` : envoyé au réseau ; `delivered` : livraison confirmée ; `failed` / `undelivered` : échec.

Une clé d’idempotence comporte 8 à 128 caractères. Après un timeout, n’utilisez pas une nouvelle clé : elle pourrait créer un second message. La clé reste conservée tant que la soumission est incertaine, puis 24 heures après sa résolution. Une garantie « exactement une fois » n’est pas possible après tous les types de panne fournisseur.

Limite : 10 requêtes SMS par minute et par utilisateur, en plus des quotas et restrictions de destinataires configurés pour l’organisation.

## 5. Préparer un appel

La voix nécessite un appareil et le SDK vocal. L’API ne déclenche pas d’appel autonome entre deux numéros.

1. `POST /v1/devices` avec `{ "organizationId": "ORG_UUID", "platform": "web", "label": "Mon CRM" }`.
2. `POST /v1/voice/token` avec `{ "organizationId": "ORG_UUID", "lineId": "LINE_UUID", "deviceId": "DEVICE_UUID" }`.
3. Initialisez le SDK vocal avec le `token`. Suivez `expiresAt` pour le renouveler. La réception entrante dépend de `incomingEnabled`.
4. `POST /v1/call-intents` avec ces trois identifiants et `destination`, plus un en-tête `Idempotency-Key`.
5. Démarrez le SDK avec `params: { To: destination, CallIntentId: intent.id }`.
6. Si l’intention reste inutilisée, annulez-la avec `POST /v1/call-intents/{id}/cancel`.

Les intentions expirent rapidement : préparez-les au moment de composer. Les limites sont de 5 intentions et 30 jetons vocaux par minute et par utilisateur. Pour recevoir sur le web, déclarez l’inscription via `PUT /v1/devices/{id}/voice-state` avec `{ "registered": true }` après la registration SDK, puis renouvelez-la toutes les 30 secondes ; le routage l’expire après 90 secondes. À la déconnexion, transmettez `registered: false`.

## 6. Recevoir les événements

Consultez [le guide des webhooks](webhooks.md) : événements disponibles, payloads, signature, reprises et exemples. Un administrateur les configure dans les réglages ; la livraison continue sans session utilisateur ouverte tant que son accès administrateur reste actif.

## Erreurs et compatibilité

Les erreurs JSON ont la forme `{ "code": "…", "message": "…", "requestId": "…" }`. Conservez `requestId` pour le support, sans journaliser les tokens ni le contenu des messages.

| HTTP | Action du client |
| --- | --- |
| 400 | Corriger les paramètres selon le schéma. |
| 401 | Renouveler la session ou reconnecter l’utilisateur. |
| 403 | Vérifier l’organisation, le rôle et l’affectation à la ligne. |
| 404 | Vérifier l’identifiant et son périmètre. |
| 409 | Relire l’état/la version avant de réessayer. |
| 429 | Attendre la prochaine fenêtre ; les limites d’émission sont par minute. |
| 500 / 503 | Réessayer avec temporisation ; conserver la clé des mutations idempotentes. |

Tolérer les nouveaux champs JSON. Une mutation sans clé d’idempotence documentée (création de contact, d’appareil ou de webhook) ne doit pas être réessayée aveuglément après un résultat incertain : relire la liste correspondante. La [politique de compatibilité](api-compatibility.md) précise l’évolution de `/v1`.
