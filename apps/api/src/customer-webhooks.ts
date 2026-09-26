import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  uuidSchema,
  webhookCreateSchema,
  webhookUpdateSchema,
  type Database,
  type Json,
} from "@onoff/contracts";
import type { AppConfig } from "./config.js";
import {
  webhookResult,
  webhookStore,
  type EndpointRow,
} from "./customer-webhook-store.js";
import {
  encryptWebhookSecret,
  newWebhookSecret,
  resolveWebhookTarget,
} from "./customer-webhook-delivery.js";

type Params = { orgId: string; id: string; deliveryId: string };
const publicEndpoint = (row: EndpointRow) => ({
  id: row.id,
  description: row.description,
  url: row.url,
  events: row.events,
  enabled: row.enabled,
  createdAt: row.created_at,
});
export function registerCustomerWebhooks(
  app: FastifyInstance,
  config: AppConfig,
  client: SupabaseClient<Database> | null,
) {
  const root = "/v1/organizations/:orgId/webhooks";
  async function scope(request: FastifyRequest<{ Params: Params }>) {
    const org = uuidSchema.parse(request.params.orgId);
    if (!client || !config.WEBHOOK_ENCRYPTION_KEY)
      throw Object.assign(
        new Error("Les webhooks ne sont pas activés sur cet environnement."),
        { statusCode: 503 },
      );
    const store = webhookStore(client),
      actor = request.context!.userId;
    const member = webhookResult(
      await store
        .from("memberships")
        .select("role")
        .eq("organization_id", org)
        .eq("user_id", actor)
        .eq("status", "active")
        .maybeSingle(),
    );
    const organization = webhookResult(
      await store
        .from("organizations")
        .select("id")
        .eq("id", org)
        .eq("status", "active")
        .maybeSingle(),
    );
    if (member?.role !== "admin" || !organization)
      throw Object.assign(new Error("Accès administrateur requis."), {
        statusCode: 403,
      });
    return { store, org, actor };
  }
  async function mutate(
    request: FastifyRequest<{ Params: Params }>,
    action: string,
    input: Json = {},
  ) {
    const { store, org, actor } = await scope(request);
    return webhookResult(
      await store.rpc("manage_customer_webhook", {
        p_org: org,
        p_actor: actor,
        p_action: action,
        p_id: uuidSchema.parse(request.params.id),
        p_input: input,
      }),
    );
  }
  app.get<{ Params: Params }>(root, async (request) => {
    const { store, org } = await scope(request);
    const items = webhookResult(
      await store
        .from("webhook_endpoints")
        .select("id,description,url,events,enabled,created_at")
        .eq("organization_id", org)
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
    );
    return {
      items: (items ?? []).map((row) => publicEndpoint(row as EndpointRow)),
    };
  });
  app.post<{ Params: Params }>(root, async (request, reply) => {
    const { store, org, actor } = await scope(request),
      input = webhookCreateSchema.parse(request.body);
    try {
      await resolveWebhookTarget(input.url);
    } catch {
      return reply
        .code(400)
        .send({
          code: "invalid_webhook_url",
          message:
            "L’URL doit résoudre vers une adresse HTTPS publique accessible.",
          requestId: request.id,
        });
    }
    const secret = newWebhookSecret();
    const row = webhookResult(
      await store.rpc("manage_customer_webhook", {
        p_org: org,
        p_actor: actor,
        p_action: "create",
        p_id: randomUUID(),
        p_input: {
          ...input,
          secretCiphertext: encryptWebhookSecret(
            secret,
            config.WEBHOOK_ENCRYPTION_KEY!,
          ),
        },
      }),
    );
    reply.header("cache-control", "no-store");
    return reply
      .code(201)
      .send({ ...publicEndpoint(row as unknown as EndpointRow), secret });
  });
  app.patch<{ Params: Params }>(`${root}/:id`, async (request) =>
    publicEndpoint(
      (await mutate(
        request,
        "enabled",
        webhookUpdateSchema.parse(request.body),
      )) as unknown as EndpointRow,
    ),
  );
  app.delete<{ Params: Params }>(`${root}/:id`, async (request, reply) => {
    await mutate(request, "delete");
    return reply.code(204).send();
  });
  app.post<{ Params: Params }>(
    `${root}/:id/rotate-secret`,
    async (request, reply) => {
      await scope(request);
      const secret = newWebhookSecret();
      await mutate(request, "rotate", {
        secretCiphertext: encryptWebhookSecret(
          secret,
          config.WEBHOOK_ENCRYPTION_KEY!,
        ),
      });
      reply.header("cache-control", "no-store");
      return { secret };
    },
  );
  app.post<{ Params: Params }>(`${root}/:id/test`, async (request, reply) =>
    reply.code(202).send(await mutate(request, "test")),
  );
  app.post<{ Params: Params }>(
    `${root}/:id/deliveries/:deliveryId/retry`,
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await mutate(request, "replay", {
            deliveryId: uuidSchema.parse(request.params.deliveryId),
          }),
        ),
  );
  app.get<{ Params: Params }>(`${root}/:id/deliveries`, async (request) => {
    const { store, org } = await scope(request),
      id = uuidSchema.parse(request.params.id);
    const endpoint = webhookResult(
      await store
        .from("webhook_endpoints")
        .select("id")
        .eq("organization_id", org)
        .eq("id", id)
        .is("deleted_at", null)
        .maybeSingle(),
    );
    if (!endpoint)
      throw Object.assign(new Error("Webhook introuvable."), {
        statusCode: 404,
      });
    const rows =
      webhookResult(
        await store
          .from("webhook_deliveries")
          .select(
            "id,event_id,status,attempts,http_status,last_error,created_at,next_attempt_at,delivered_at",
          )
          .eq("organization_id", org)
          .eq("endpoint_id", id)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(50),
      ) ?? [];
    const events = rows.length
      ? webhookResult(
          await store
            .from("webhook_events")
            .select("id,event_type")
            .eq("organization_id", org)
            .in(
              "id",
              rows.map((row) => row.event_id),
            ),
        )
      : [];
    return {
      items: rows.map((row) => ({
        id: row.id,
        eventId: row.event_id,
        eventType:
          events?.find((event) => event.id === row.event_id)?.event_type ??
          "unknown",
        status: row.status,
        attempts: row.attempts,
        httpStatus: row.http_status,
        lastError: row.last_error,
        createdAt: row.created_at,
        nextAttemptAt: row.next_attempt_at,
        deliveredAt: row.delivered_at,
      })),
    };
  });
}
