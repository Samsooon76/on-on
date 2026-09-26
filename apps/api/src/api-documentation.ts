import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  errorResponseSchema,
  webhookEventLabels,
  webhookPayloadSchema,
} from "@onoff/contracts";
import {
  requestBodySchemas,
  successResponseSchemas,
} from "./response-schemas.js";
import type { AppConfig } from "./config.js";

const summaries: Record<string, string> = {
  "GET /v1/me": "Identifier l’utilisateur et ses organisations",
  "GET /v1/organizations": "Lister ses organisations",
  "GET /v1/services": "Vérifier les services activés",
  "GET /v1/organizations/:orgId/lines": "Lister ses lignes autorisées",
  "GET /v1/organizations/:orgId/contacts": "Rechercher les contacts",
  "POST /v1/organizations/:orgId/contacts": "Créer un contact",
  "GET /v1/contacts/:id": "Lire un contact",
  "PATCH /v1/contacts/:id": "Modifier un contact avec sa version",
  "DELETE /v1/contacts/:id": "Archiver un contact",
  "GET /v1/lines/:lineId/calls": "Lire l’historique des appels",
  "GET /v1/lines/:lineId/conversations": "Lister les conversations",
  "GET /v1/conversations/:id/messages": "Lire les messages d’une conversation",
  "PUT /v1/conversations/:id/read": "Marquer une conversation comme lue",
  "GET /v1/messages/pending": "Retrouver ses envois SMS incertains",
  "POST /v1/messages": "Envoyer un SMS",
  "GET /v1/devices": "Lister ses appareils",
  "POST /v1/devices": "Enregistrer un appareil",
  "PUT /v1/devices/:id/voice-state":
    "Déclarer l’inscription vocale de son appareil",
  "POST /v1/devices/:id/revoke": "Révoquer un appareil",
  "POST /v1/voice/token": "Obtenir un jeton pour le SDK vocal",
  "POST /v1/call-intents": "Préparer un appel depuis un appareil",
  "POST /v1/call-intents/:id/cancel": "Annuler une intention inutilisée",
};
const webhookRoot = "/v1/organizations/:orgId/webhooks";
Object.assign(summaries, {
  [`GET ${webhookRoot}`]: "Lister les webhooks de l’organisation",
  [`POST ${webhookRoot}`]: "Créer un webhook et obtenir son secret",
  [`PATCH ${webhookRoot}/:id`]: "Activer ou suspendre un webhook",
  [`DELETE ${webhookRoot}/:id`]: "Supprimer un webhook",
  [`POST ${webhookRoot}/:id/rotate-secret`]:
    "Renouveler le secret de signature",
  [`POST ${webhookRoot}/:id/test`]: "Mettre un événement de test en file",
  [`GET ${webhookRoot}/:id/deliveries`]:
    "Consulter les 50 dernières livraisons",
  [`POST ${webhookRoot}/:id/deliveries/:deliveryId/retry`]:
    "Relancer une livraison en échec",
});
const noContent = new Set([
  "DELETE /v1/contacts/:id",
  "PUT /v1/conversations/:id/read",
  `DELETE ${webhookRoot}/:id`,
]);
const paginated = new Set([
  "GET /v1/organizations/:orgId/contacts",
  "GET /v1/lines/:lineId/calls",
  "GET /v1/lines/:lineId/conversations",
  "GET /v1/conversations/:id/messages",
]);
function jsonSchema(schema: z.ZodType, io: "input" | "output" = "output") {
  const { $schema, ...result } = z.toJSONSchema(schema, { io });
  return result;
}
function category(path: string) {
  return path.includes("webhooks")
    ? "Webhooks"
    : path.includes("contacts")
      ? "Contacts"
      : /messages|conversations/.test(path)
        ? "SMS"
        : /calls|call-intents|voice|devices/.test(path)
          ? "Appels et appareils"
          : "Compte";
}
export function buildApiSpec(baseUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [key, summary] of Object.entries(summaries)) {
    const [method, rawPath] = key.split(" ") as [string, string],
      path = rawPath.replace(/:([A-Za-z]+)/g, "{$1}");
    const parameters: Record<string, unknown>[] = [
      ...rawPath.matchAll(/:([A-Za-z]+)/g),
    ].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    }));
    if (paginated.has(key))
      parameters.push(
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 30 },
        },
        {
          name: "cursor",
          in: "query",
          description: "Reprendre nextCursor tel quel.",
          schema: { type: "string" },
        },
      );
    if (key === "GET /v1/organizations/:orgId/contacts")
      parameters.push({
        name: "q",
        in: "query",
        description: "Nom, adresse email ou numéro complet.",
        schema: { type: "string" },
      });
    if (["POST /v1/messages", "POST /v1/call-intents"].includes(key))
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        description:
          "Réutiliser la même clé et le même corps après un timeout.",
        schema: { type: "string", minLength: 8, maxLength: 128 },
      });
    const responses: Record<string, unknown> = {};
    for (const status of [400, 401, 403, 404, 409, 429, 500, 503])
      responses[status] = {
        description: (
          {
            400: "Requête invalide",
            401: "Session absente ou expirée",
            403: "Droits insuffisants",
            404: "Ressource introuvable",
            409: "Conflit d’état ou de version",
            429: "Limite de débit",
            500: "Erreur interne",
            503: "Service indisponible",
          } as Record<number, string>
        )[status],
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      };
    if (noContent.has(key))
      responses[204] = {
        description: "Opération effectuée, réponse sans corps",
      };
    for (const [status, schema] of Object.entries(
      successResponseSchemas.get(key) ?? {},
    ))
      responses[status] = {
        description:
          status === "202"
            ? "Traitement en attente ou résultat SMS incertain"
            : status === "201"
              ? "Ressource créée"
              : status === "422"
                ? "SMS refusé par le fournisseur"
                : "Succès",
        content: { "application/json": { schema: jsonSchema(schema) } },
      };
    const body = requestBodySchemas.get(key);
    const description = rawPath.includes("webhooks")
      ? "Administrateur actif de l’organisation requis. Les abonnements couvrent toutes les lignes de l’organisation. Les livraisons s’arrêtent si le créateur perd ce rôle."
      : key === "POST /v1/call-intents"
        ? "Prépare une intention : démarrer ensuite le SDK vocal avec le paramètre CallIntentId. Cette route ne lance pas un appel autonome serveur à serveur."
        : key === "POST /v1/messages"
          ? "Nécessite une affectation SMS active. 201 confirme la soumission ; 202 impose de vérifier le résultat avec la même clé. delivered confirme la livraison au terminal, sent l’envoi au réseau."
          : "Les droits de la session et les affectations aux lignes sont vérifiés à chaque requête.";
    paths[path] ??= {};
    paths[path]![method.toLowerCase()] = {
      summary,
      description,
      tags: [category(rawPath)],
      operationId: method.toLowerCase() + rawPath.replace(/[^A-Za-z0-9]/g, "_"),
      security: [{ userSession: [] }],
      parameters,
      ...(body
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: jsonSchema(body, "input") },
              },
            },
          }
        : {}),
      responses,
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Onoff API",
      version: "1.0.0",
      description:
        "API clients v1 : comptes, contacts, SMS, appels et webhooks. Authentification par session utilisateur Supabase. Les jetons MCP sont réservés à /mcp. Les nouvelles propriétés de réponse peuvent être ajoutées sans changement de version.",
    },
    servers: [{ url: baseUrl.replace(/\/$/, "") }],
    paths,
    components: {
      securitySchemes: {
        userSession: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "access_token d’une session Supabase utilisateur. Renouveler via le SDK Auth ; aucun jeton administrateur ni clé serveur côté client.",
        },
      },
      schemas: {
        Error: jsonSchema(errorResponseSchema),
        WebhookEvent: jsonSchema(webhookPayloadSchema),
      },
    },
    webhooks: {
      customerEvent: {
        post: {
          summary: "Événement envoyé à votre URL HTTPS",
          description:
            "Signature HMAC-SHA256 dans X-Onoff-Signature : t=<timestamp>,v1=<hex>. Signer timestamp + '.' + corps JSON brut avec le secret whsec_ complet. Tolérance recommandée : 300 secondes. Livraison au moins une fois ; dédupliquer par id, ordre non garanti.",
          parameters: [
            {
              name: "X-Onoff-Signature",
              in: "header",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "X-Onoff-Event-Id",
              in: "header",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
            {
              name: "X-Onoff-Delivery-Id",
              in: "header",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
            {
              name: "X-Onoff-Attempt",
              in: "header",
              required: true,
              schema: { type: "integer", minimum: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WebhookEvent" },
              },
            },
          },
          responses: {
            "204": {
              description:
                "Événement enregistré durablement ; tout code 2xx accuse réception.",
            },
            "503": { description: "Réessayer plus tard." },
          },
        },
      },
    },
  };
}
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
export function documentationHtml(baseUrl: string, nonce: string) {
  const spec = buildApiSpec(baseUrl);
  const endpointHtml = Object.entries(spec.paths)
    .flatMap(([path, operations]) =>
      Object.entries(operations).map(([method, raw]) => {
        const operation = raw as {
          summary: string;
          description: string;
          tags: string[];
          parameters: unknown[];
          requestBody?: unknown;
          responses: unknown;
        };
        return `<details class="endpoint" data-search="${escape(`${operation.tags.join(" ")} ${method} ${path} ${operation.summary}`.toLowerCase())}"><summary><span class="method">${method.toUpperCase()}</span><code>${escape(path)}</code><span>${escape(operation.summary)}</span></summary><div class="endpoint-body"><p>${escape(operation.description)}</p><h4>Paramètres</h4><pre>${escape(JSON.stringify(operation.parameters, null, 2))}</pre>${operation.requestBody ? `<h4>Corps JSON</h4><pre>${escape(JSON.stringify(operation.requestBody, null, 2))}</pre>` : ""}<h4>Réponses</h4><pre>${escape(JSON.stringify(operation.responses, null, 2))}</pre></div></details>`;
      }),
    )
    .join("");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Onoff · API & webhooks</title><style>
  :root{color-scheme:light;font-family:system-ui,sans-serif;color:#18372b;background:#fafbf9}*{box-sizing:border-box}body{margin:0;line-height:1.6}a{color:#196442;text-underline-offset:4px}header{padding:20px 5vw;border-bottom:1px solid #dce4dc;background:white;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}header strong{font-size:22px;letter-spacing:-1px}header span{color:#52685b;font-size:13px}main{max-width:1180px;margin:auto;padding:56px 28px 100px}nav{display:flex;gap:22px;flex-wrap:wrap;margin-bottom:48px;font-size:14px}h1{font-size:clamp(36px,5vw,60px);letter-spacing:-2px;line-height:1.12;max-width:760px;margin:12px 0 22px}h2{font-size:27px;letter-spacing:-.7px;margin:55px 0 18px}h3{margin:26px 0 12px}p{max-width:800px}.intro{font-size:18px;color:#52685b;max-width:710px}.eyebrow{font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#617767}.pill{display:inline-block;font-size:12px;border:1px solid #cbd9cd;padding:4px 10px;border-radius:5px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:26px}pre{background:#112b22;color:#daf0e3;padding:20px;overflow:auto;border-radius:7px;font-size:12px;line-height:1.65}code{font-family:ui-monospace,monospace;font-size:.87em}td,th{text-align:left;padding:12px;border-bottom:1px solid #dce4dc}table{border-collapse:collapse;width:100%;font-size:14px}.table-wrap{overflow:auto}input{font:inherit;padding:14px;width:100%;border:1px solid #bccfbe;border-radius:6px;margin:10px 0 22px;background:white}.endpoint{border-bottom:1px solid #dce4dc;background:white}.endpoint summary{cursor:pointer;display:flex;align-items:baseline;flex-wrap:wrap;gap:12px;padding:18px}.endpoint summary>span:last-child{color:#657568;font-size:13px}.method{font-size:11px;font-weight:750;min-width:55px;color:#276a49}.endpoint-body{padding:0 22px 20px}.note{border-left:3px solid #3f7c54;padding:12px 20px;background:#eff5ee}.count{font-size:13px;color:#657568}section{scroll-margin-top:20px}footer{border-top:1px solid #dce4dc;margin-top:50px;padding-top:20px;font-size:13px;color:#657568}@media(max-width:700px){.grid{grid-template-columns:1fr}main{padding:32px 18px}summary code{overflow-wrap:anywhere}td,th{padding:10px 6px;min-width:0;font-size:12px}td code{overflow-wrap:anywhere}table{table-layout:fixed}}
  </style></head><body><header><strong>onoff <span>/ développeurs</span></strong><a href="/openapi.json" download="onoff-openapi.json">Télécharger OpenAPI 3.1 ↗</a></header><main><nav aria-label="Documentation"><a href="#start">Démarrage</a><a href="#sms">SMS et appels</a><a href="#webhooks">Webhooks</a><a href="#reference">Référence API</a></nav><span class="pill">API v1</span><h1>Connectez votre produit<br>à vos conversations.</h1><p class="intro">Contacts, SMS, appels et événements : les contrats et les exemples pour intégrer Onoff à vos outils.</p>
  <section id="start"><h2>01 · Votre première requête</h2><p>Base URL : <code>${escape(baseUrl)}</code>. Utilisez le <code>access_token</code> de votre session utilisateur Supabase dans chaque requête. Le SDK Auth renouvelle la session. Les clés API permanentes ne sont pas disponibles dans cette version.</p><details><summary>Obtenir une session dans votre application JavaScript</summary><p>Votre administrateur fournit l’URL Supabase et sa clé publique. Installez <code>@supabase/supabase-js</code>, puis connectez votre utilisateur. Utilisez ensuite la session renouvelée par le SDK.</p><pre>import { createClient } from '@supabase/supabase-js';
const auth = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const { data, error } = await auth.auth.signInWithPassword({ email, password });
if (error) throw error;
const accessToken = data.session.access_token;</pre></details><pre>curl '${escape(baseUrl)}/v1/me' \\\n  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN'</pre><p>Récupérez ensuite vos lignes avec <code>GET /v1/organizations/{orgId}/lines</code>. Chaque action respecte vos affectations et vos permissions. Une session d’assistant MCP est utilisable sur <code>/mcp</code>.</p><div class="grid"><div><h3>Pagination</h3><p>Les listes paginées renvoient <code>{ items, nextCursor }</code>. Passez <code>limit=30</code> (100 maximum), puis <code>cursor=nextCursor</code> jusqu’à obtenir <code>null</code>. Encodez le curseur dans l’URL.</p></div><div><h3>Erreurs</h3><p>Les erreurs renvoient <code>{ code, message, requestId }</code>. 401 : renouveler la session ; 403 : vérifier les droits ; 409 : relire la version ; 429 : attendre avant de réessayer.</p></div></div></section>
  <section id="sms"><h2>02 · Envoyer un SMS, préparer un appel</h2><pre>curl '${escape(baseUrl)}/v1/messages' \\\n  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: YOUR_UNIQUE_REQUEST_ID' \\\n  -d '{"organizationId":"ORG_UUID","lineId":"LINE_UUID",
       "destination":"+33612345678","body":"Votre rendez-vous est confirmé."}'</pre><p>Un SMS soumis renvoie <code>201</code>. Si la réponse est <code>202</code> ou si la requête expire, réutilisez la même clé et le même corps pour vérifier l’envoi. <code>sent</code> signifie envoyé au réseau ; <code>delivered</code> confirme la livraison.</p><p>Pour la voix : enregistrez un appareil, obtenez un jeton via <code>POST /v1/voice/token</code>, puis créez <code>POST /v1/call-intents</code> avec <code>organizationId</code>, <code>lineId</code>, <code>deviceId</code> et <code>destination</code>. Démarrez le SDK vocal avec <code>CallIntentId</code>. Une intention seule ne déclenche pas d’appel.</p><p class="note">Limites par utilisateur : 10 SMS, 5 intentions d’appel et 30 jetons vocaux par minute. Les services, destinataires autorisés et quotas de votre organisation s’appliquent aussi à l’API.</p></section>
  <section id="webhooks"><h2>03 · Recevoir les événements</h2><p>Dans les réglages, un administrateur peut ajouter une URL HTTPS, choisir les événements et lancer un test. Le secret de signature est affiché une seule fois. Les abonnements couvrent toute l’organisation et dépendent du rôle administrateur de leur créateur.</p><div class="table-wrap"><table><thead><tr><th>Événement</th><th>Déclencheur</th></tr></thead><tbody>${Object.entries(
    webhookEventLabels,
  )
    .map(
      ([event, label]) =>
        `<tr><td><code>${event}</code></td><td>${label}</td></tr>`,
    )
    .join(
      "",
    )}</tbody></table></div><p><code>call.connected</code> correspond à la première connexion enregistrée avec le correspondant ou un agent ; l’accueil IVR seul ne compte pas. <code>call.ended</code> couvre tous les résultats, y compris les échecs. Un appel entrant sans connexion émet aussi <code>call.missed</code>.</p><p><code>user.status_changed</code> décrit le compte et le rôle. <code>user.reachability_changed</code> décrit l’application : <code>available</code>, <code>busy</code> (réservation/appel en cours) ou <code>offline</code>. Cette disponibilité est observée périodiquement ; elle ne décrit pas l’activité TaskRouter ni les renvois externes.</p><pre>{
  "id": "EVENT_UUID", "type": "call.connected", "apiVersion": "v1",
  "createdAt": "2026-09-26T12:00:00Z", "organizationId": "ORG_UUID",
  "data": { "id": "CALL_UUID", "lineId": "LINE_UUID", "direction": "inbound",
    "remoteNumber": "+33612345678", "status": "answered",
    "startedAt": "2026-09-26T11:59:55Z", "answeredAt": "2026-09-26T12:00:00Z",
    "endedAt": null, "durationSeconds": null }
}</pre><details><summary>Schémas des événements (tous les champs)</summary><pre>${escape(JSON.stringify(spec.components.schemas.WebhookEvent, null, 2))}</pre></details><h3>Vérifier la signature</h3><p>L’en-tête <code>X-Onoff-Signature</code> contient <code>t=TIMESTAMP,v1=SIGNATURE_HEX</code>. Calculez un HMAC-SHA256 de <code>timestamp + '.' + corps brut</code> avec le secret complet <code>whsec_…</code>. Comparez en temps constant et rejetez une date éloignée de plus de 300 secondes.</p><details><summary>Exemple de vérification Node.js</summary><pre>${escape(`import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, header, secret) {
  const fields = /^t=(\\d{1,12}),v1=([a-f0-9]{64})$/.exec(header ?? '');
  if (!fields || Math.abs(Date.now()/1000 - Number(fields[1])) > 300) return false;
  const expected = createHmac('sha256', secret)
    .update(fields[1] + '.').update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(fields[2], 'hex'));
}
// rawBody doit être un Buffer, avant tout parsing JSON.
// Après vérification : insérer durablement l’événement dans votre file,
// avec une contrainte unique sur event.id, puis répondre 204.`)}</pre></details><p>Enregistrez l’événement durablement, puis répondez <code>2xx</code> en moins de 5 secondes. Dédupliquez par <code>id</code> : plusieurs livraisons sont possibles et l’ordre n’est pas garanti. Après un échec, jusqu’à 8 tentatives au total, avec délais de 30 s, 2 min, 10 min, 30 min, 2 h, 6 h et 24 h. Historique conservé 7 jours. Les redirections sont traitées comme des échecs.</p><p>Les SMS contiennent leur texte et leur statut ; les appels leurs horodatages ; les messages vocaux leur identifiant et durée. L’API n’envoie ni identifiants fournisseur ni liens d’enregistrement privés dans les webhooks.</p></section>
  <section id="reference"><h2>04 · Référence des endpoints</h2><label for="search">Rechercher une route ou une ressource</label><input id="search" type="search" placeholder="SMS, contacts, webhooks…"><p id="count" class="count" role="status"></p>${endpointHtml}</section><footer>Contrats issus des schémas utilisés par l’API. Importez OpenAPI dans votre client HTTP pour préparer vos requêtes.</footer></main><script nonce="${nonce}">const search=document.getElementById('search');const endpoints=[...document.querySelectorAll('.endpoint')];function filter(){const q=search.value.toLowerCase().trim();let n=0;for(const el of endpoints){el.hidden=!el.dataset.search.includes(q);if(!el.hidden)n++;}document.getElementById('count').textContent=n+' routes disponibles';}search.addEventListener('input',filter);filter();</script></body></html>`;
}
export function registerApiDocumentation(
  app: FastifyInstance,
  config: AppConfig,
) {
  app.get("/openapi.json", async () => buildApiSpec(config.API_PUBLIC_URL));
  app.get("/docs", async (_request, reply) => {
    const nonce = randomBytes(16).toString("base64");
    reply
      .header(
        "content-security-policy",
        `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
      )
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer");
    return reply
      .type("text/html; charset=utf-8")
      .send(documentationHtml(config.API_PUBLIC_URL.replace(/\/$/, ""), nonce));
  });
}
