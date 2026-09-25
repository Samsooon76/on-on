import Fastify, { type FastifyInstance } from "fastify";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import twilio from "twilio";
import { z } from "zod";
import { hasZodFastifySchemaValidationErrors, serializerCompiler, validatorCompiler, type ZodTypeProvider } from "@fastify/type-provider-zod";
import { callIntentCreateSchema, contactCreateSchema, contactUpdateSchema, deviceCreateSchema, lineAssignmentUpdateSchema, messageCreateSchema, paginationSchema, uuidSchema, voiceTargetSchema, type Database } from "@onoff/contracts";
import type { AppConfig } from "./config.js";
import { requestBodySchemas, responsesForRoute } from "./response-schemas.js";
import { findAssignedLine, getActiveOrganizationIds, isActiveOrganizationAdmin } from "./repositories/access.js";
import { persistLineAssignment } from "./repositories/line-assignments.js";
import { createVoiceAccessToken } from "./voice.js";

export type RequestContext = {
  userId: string;
  accessToken: string;
  supabase: SupabaseClient<Database>;
};

type SmsProvider = {
  messages: {
    create(input: { from: string; to: string; body: string; statusCallback: string }): Promise<{
      sid: string;
      status: string;
      errorCode?: number | null;
    }>;
  };
};

export type ApiDependencies = {
  createSupabaseClient?: typeof createClient<Database>;
  createSmsProvider?: (apiKeySid: string, apiKeySecret: string, accountSid: string) => SmsProvider;
};

type PageCursor = { createdAt: string; id: string };
const voiceDiagnosticSchema = z.object({
  event: z.enum(["voice_registration_failed", "history_refresh_succeeded", "history_refresh_failed"]),
  platform: z.enum(["web", "ios", "android"]),
  appVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/).max(32),
  durationMs: z.number().int().min(0).max(300_000).optional(),
});

function safeProviderCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return undefined;
}

function decodeCursor(value: string | undefined): PageCursor | null | false {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt)) || typeof parsed.id !== "string" || !uuidSchema.safeParse(parsed.id).success) return false;
    return { createdAt: new Date(parsed.createdAt).toISOString(), id: parsed.id };
  } catch {
    return false;
  }
}

function encodeCursor(row: { id: string } & ({ created_at: string } | { last_message_at: string })): string {
  const createdAt = "created_at" in row ? row.created_at : row.last_message_at;
  return Buffer.from(JSON.stringify({ createdAt, id: row.id })).toString("base64url");
}

async function resolveUniqueContactNames(supabase: SupabaseClient<Database>, organizationId: string, phoneNumbers: string[]): Promise<Map<string, string>> {
  const uniqueNumbers = [...new Set(phoneNumbers)];
  if (!uniqueNumbers.length) return new Map();
  const { data: phoneRows, error: phoneError } = await supabase.from("contact_phones")
    .select("phone_number, contact_id").eq("organization_id", organizationId).in("phone_number", uniqueNumbers);
  if (phoneError) throw new Error("Impossible de résoudre les contacts des activités.");
  const contactIds = [...new Set((phoneRows ?? []).map((row) => row.contact_id))];
  if (!contactIds.length) return new Map();
  const { data: contacts, error: contactError } = await supabase.from("contacts")
    .select("id, display_name").eq("organization_id", organizationId).is("archived_at", null).in("id", contactIds);
  if (contactError) throw new Error("Impossible de résoudre les contacts des activités.");
  const namesById = new Map((contacts ?? []).map((contact) => [contact.id, contact.display_name]));
  const contactNamesByNumber = new Map<string, Map<string, string>>();
  for (const row of phoneRows ?? []) {
    const name = namesById.get(row.contact_id);
    if (!name) continue;
    const matches = contactNamesByNumber.get(row.phone_number) ?? new Map<string, string>();
    matches.set(row.contact_id, name);
    contactNamesByNumber.set(row.phone_number, matches);
  }
  return new Map([...contactNamesByNumber].flatMap(([number, matches]) => matches.size === 1 ? [[number, [...matches.values()][0]!] as const] : []));
}

declare module "fastify" {
  interface FastifyRequest {
    context: RequestContext | null;
  }
}

export function createApp(config: AppConfig, dependencies: ApiDependencies = {}): FastifyInstance {
  const makeSupabaseClient = dependencies.createSupabaseClient ?? createClient<Database>;
  const makeSmsProvider = dependencies.createSmsProvider ?? ((apiKeySid, apiKeySecret, accountSid) =>
    twilio(apiKeySid, apiKeySecret, { accountSid }) as unknown as SmsProvider);
  const webhookStartedAt = new WeakMap<object, number>();
  let lastDiagnosticLimiterWarningAt = 0;
  const app = Fastify({
    bodyLimit: 64 * 1024,
    requestTimeout: 15_000,
    connectionTimeout: 10_000,
    keepAliveTimeout: 5_000,
    forceCloseConnections: "idle",
    trustProxy: true,
    requestIdHeader: false,
    genReqId: (request) => {
      const suppliedId = request.headers["x-request-id"];
      return typeof suppliedId === "string" && uuidSchema.safeParse(suppliedId).success ? suppliedId : randomUUID();
    },
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.url", "req.remoteAddress", "req.remotePort", "req.headers.authorization", "req.headers.cookie", "req.headers.referer", "req.headers.x-api-key", "req.headers.x-forwarded-for", "req.headers.x-real-ip", "req.headers.x-request-id", "req.headers.x-twilio-signature", "res.headers.set-cookie"],
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook("onRoute", (routeOptions) => {
    const method = String(routeOptions.method);
    const bodySchema = requestBodySchemas.get(`${method} ${routeOptions.url}`);
    const responseSchemas = responsesForRoute(method, routeOptions.url);
    if (!bodySchema && !responseSchemas) return;

    const schema = { ...(routeOptions.schema ?? {}) } as Record<string, unknown>;
    if (bodySchema) schema.body = bodySchema;
    if (responseSchemas) {
      schema.response = {
        ...((schema.response as Record<string | number, unknown> | undefined) ?? {}),
        ...responseSchemas,
      };
    }
    routeOptions.schema = schema as never;
  });

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (request, body, done) => {
    const fields = Object.fromEntries(new URLSearchParams(body as string).entries());
    done(null, fields);
  });

  const serviceSupabase = config.SUPABASE_SECRET_KEY
    ? makeSupabaseClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
    : null;

  function validateTwilioWebhook(request: { headers: Record<string, string | string[] | undefined>; url: string; body: unknown; log?: FastifyInstance["log"]; id?: string }): boolean {
    const signature = request.headers["x-twilio-signature"];
    if (typeof signature !== "string" || !config.TWILIO_AUTH_TOKEN) {
      request.log?.warn({ requestId: request.id, webhook: request.url.split("?")[0], reason: typeof signature === "string" ? "validation_unavailable" : "signature_missing" }, "Twilio webhook signature rejected");
      return false;
    }
    const url = new URL(request.url, config.API_PUBLIC_URL).toString();
    const params = request.body && typeof request.body === "object" ? request.body as Record<string, string> : {};
    const valid = twilio.validateRequest(config.TWILIO_AUTH_TOKEN, signature, url, params);
    if (!valid) request.log?.warn({ requestId: request.id, webhook: request.url.split("?")[0], reason: "signature_invalid" }, "Twilio webhook signature rejected");
    return valid;
  }

  async function consumeUserRateLimit(userId: string, operation: "voice_token" | "call_intent" | "sms_send" | "voice_client_diagnostic", windowSeconds: number, maxRequests: number): Promise<boolean | null> {
    if (!serviceSupabase) return null;
    const { data, error } = await serviceSupabase.rpc("consume_api_rate_limit", {
      p_user_id: userId,
      p_operation: operation,
      p_window_seconds: windowSeconds,
      p_max_requests: maxRequests,
    });
    if (error || typeof data !== "boolean") return null;
    return data;
  }

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/webhooks/twilio/")) webhookStartedAt.set(request, performance.now());
    const origin = request.headers.origin;
    if (origin && config.allowedOrigins.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("access-control-allow-headers", "authorization, content-type, idempotency-key, x-request-id");
      reply.header("access-control-allow-methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
      reply.header("vary", "Origin");
    }
    if (request.method === "OPTIONS") return reply.code(204).send();
  });

  app.addHook("onResponse", async (request, reply) => {
    const startedAt = webhookStartedAt.get(request);
    if (startedAt === undefined) return;
    const fields = {
      requestId: request.id,
      webhook: request.url.split("?")[0],
      statusCode: reply.statusCode,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      outcome: reply.statusCode < 400 ? "ok" : reply.statusCode < 500 ? "rejected" : "failed",
    };
    if (reply.statusCode >= 500) request.log.error(fields, "Twilio webhook failed");
    else request.log.info(fields, "Twilio webhook completed");
  });

  app.setErrorHandler((caught, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(caught)) {
      request.log.info({ requestId: request.id, validationIssueCount: caught.validation.length }, "request schema rejected");
      return reply.code(400).send({ code: "invalid_request", message: "Les données de la requête sont invalides.", requestId: request.id });
    }
    const error: Error & { statusCode?: number } = caught instanceof Error
      ? caught as Error & { statusCode?: number }
      : new Error("Unknown request error");
    request.log.error({ name: error.name, statusCode: error.statusCode, requestId: request.id }, "request failed");
    const statusCode = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    const code = statusCode === 500 ? "internal_error" : "request_error";
    const message = statusCode === 500 ? "Une erreur inattendue est survenue." : error.message;
    return reply.code(statusCode).send({ code, message, requestId: request.id });
  });

  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get("/health/live", async () => ({ status: "ok", version: config.API_VERSION }));
  routes.get("/health/ready", async (_request, reply) => {
    const [authResponse, databaseResponse] = await Promise.all([
      fetch(`${config.SUPABASE_URL}/auth/v1/health`, {
        headers: { apikey: config.SUPABASE_PUBLISHABLE_KEY },
        signal: AbortSignal.timeout(2500),
      }).catch(() => null),
      fetch(`${config.SUPABASE_URL}/rest/v1/`, {
        headers: { apikey: config.SUPABASE_PUBLISHABLE_KEY },
        signal: AbortSignal.timeout(2500),
      }).catch(() => null),
    ]);
    const auth = authResponse?.ok === true;
    const database = databaseResponse?.ok === true;
    const ready = auth && database;
    if (!ready) reply.code(503);
    return { status: ready ? "ready" : "unavailable", version: config.API_VERSION, dependencies: { auth, database } };
  });

  app.decorateRequest("context", null);
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) return;
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer (\S+)$/i);
    if (!match?.[1]) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });

    const userClient = makeSupabaseClient(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${match[1]}` } },
    });
    const { data, error } = await userClient.auth.getUser(match[1]);
    if (error || !data.user || data.user.is_anonymous) {
      return reply.code(401).send({ code: "unauthorized", message: "Session invalide ou expirée.", requestId: request.id });
    }
    request.context = { userId: data.user.id, accessToken: match[1], supabase: userClient };
  });

  routes.post("/v1/diagnostics/voice", async (request, reply) => {
    const context = request.context;
    const parsed = voiceDiagnosticSchema.safeParse(request.body);
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!parsed.success) return reply.code(400).send({ code: "invalid_voice_diagnostic", message: "Les données de diagnostic vocal sont invalides.", requestId: request.id });
    const accepted = await consumeUserRateLimit(context.userId, "voice_client_diagnostic", 300, 10);
    if (accepted === null) {
      if (Date.now() - lastDiagnosticLimiterWarningAt >= 60_000) {
        lastDiagnosticLimiterWarningAt = Date.now();
        request.log.warn("voice client diagnostic rate limiter unavailable; event discarded");
      }
      return reply.code(202).send({ accepted: false });
    }
    if (accepted) {
      request.log.info({ event: parsed.data.event, platform: parsed.data.platform, appVersion: parsed.data.appVersion, durationMs: parsed.data.durationMs }, "voice client diagnostic");
    }
    return reply.code(202).send({ accepted });
  });

  routes.get("/v1/me", async (request, reply) => {
    const context = request.context;
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    const { data, error } = await context.supabase.from("memberships").select("organization_id, role, status, organizations(id, name)").eq("user_id", context.userId).eq("status", "active");
    if (error) throw new Error("Impossible de charger les organisations autorisées.");
    return { userId: context.userId, organizations: data };
  });

  routes.get("/v1/organizations", async (request, reply) => {
    const context = request.context;
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    const { data, error } = await context.supabase.from("memberships").select("organization_id, role, organizations(id, name)").eq("user_id", context.userId).eq("status", "active");
    if (error) throw new Error("Impossible de charger les organisations autorisées.");
    return { items: data };
  });

  routes.get<{ Params: { orgId: string }; Querystring: { limit?: string; cursor?: string; q?: string } }>("/v1/organizations/:orgId/contacts", async (request, reply) => {
    const context = request.context;
    const orgId = uuidSchema.safeParse(request.params.orgId);
    const page = paginationSchema.safeParse(request.query);
    const cursor = decodeCursor(request.query.cursor);
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!orgId.success || !page.success || cursor === false || (request.query.q !== undefined && request.query.q.length > 80)) return reply.code(400).send({ code: "invalid_request", message: "Organisation ou pagination invalide.", requestId: request.id });
    let query = context.supabase.from("contacts").select("id, organization_id, display_name, email, version, created_at, contact_phones(id, phone_number, label)").eq("organization_id", orgId.data).is("archived_at", null).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(page.data.limit + 1);
    if (cursor) query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
    if (request.query.q?.trim()) query = query.ilike("display_name", `%${request.query.q.trim()}%`);
    const { data, error } = await query;
    if (error) {
      request.log.warn({ code: error.code, requestId: request.id, table: "contacts" }, "contact list unavailable");
      return reply.code(503).send({ code: "data_unavailable", message: "Les contacts ne sont pas disponibles pour le moment.", requestId: request.id });
    }
    const items = data ?? [];
    const hasMore = items.length > page.data.limit;
    if (hasMore) items.pop();
    return { items, nextCursor: hasMore && items.length ? encodeCursor(items[items.length - 1]!) : null };
  });

  routes.post<{ Params: { orgId: string } }>("/v1/organizations/:orgId/contacts", async (request, reply) => {
    const context = request.context;
    const orgId = uuidSchema.safeParse(request.params.orgId);
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!orgId.success) return reply.code(400).send({ code: "invalid_request", message: "Organisation invalide.", requestId: request.id });
    const parsed = contactCreateSchema.safeParse({ ...(request.body as object), organizationId: orgId.data });
    if (!parsed.success) return reply.code(400).send({ code: "invalid_contact", message: "Vérifiez le nom, l'email et les numéros du contact.", requestId: request.id });

    const { data: contactId, error } = await context.supabase.rpc("create_contact_with_phones", {
      p_org_id: parsed.data.organizationId,
      p_display_name: parsed.data.displayName,
      // Postgres accepts NULL here; the generated RPC type can't express it.
      p_email: (parsed.data.email ?? null) as unknown as string,
      p_phones: parsed.data.phones.map(({ phoneNumber, label }) => ({ phone_number: phoneNumber, label })),
    });
    if (error || !contactId) {
      request.log.warn({ code: error?.code, requestId: request.id, table: "contacts" }, "contact creation rejected");
      return reply.code(error?.code === "42501" ? 403 : 400).send({ code: "contact_not_created", message: "Le contact n'a pas pu être créé dans cette organisation.", requestId: request.id });
    }
    const { data, error: readError } = await context.supabase.from("contacts").select("id, organization_id, display_name, email, version, created_at, contact_phones(id, phone_number, label)").eq("id", contactId).eq("organization_id", parsed.data.organizationId).single();
    if (readError || !data) return reply.code(201).send({ id: contactId });
    return reply.code(201).send(data);
  });

  routes.get<{ Params: { id: string } }>("/v1/contacts/:id", async (request, reply) => {
    const context = request.context;
    const id = uuidSchema.safeParse(request.params.id);
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!id.success) return reply.code(400).send({ code: "invalid_request", message: "Identifiant de contact invalide.", requestId: request.id });
    const organizationScope = await getActiveOrganizationIds(context.supabase, context.userId);
    if (organizationScope.unavailable) return reply.code(503).send({ code: "data_unavailable", message: "Le contact n'est pas disponible.", requestId: request.id });
    const organizationIds = organizationScope.data ?? [];
    if (!organizationIds.length) return reply.code(404).send({ code: "not_found", message: "Contact introuvable.", requestId: request.id });
    const { data, error } = await context.supabase.from("contacts").select("id, organization_id, display_name, email, version, created_at, contact_phones(id, phone_number, label)").in("organization_id", organizationIds).eq("id", id.data).is("archived_at", null).maybeSingle();
    if (error) return reply.code(503).send({ code: "data_unavailable", message: "Le contact n'est pas disponible.", requestId: request.id });
    if (!data) return reply.code(404).send({ code: "not_found", message: "Contact introuvable.", requestId: request.id });
    return data;
  });

  routes.patch<{ Params: { id: string } }>("/v1/contacts/:id", async (request, reply) => {
    const context = request.context;
    const id = uuidSchema.safeParse(request.params.id);
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!id.success) return reply.code(400).send({ code: "invalid_request", message: "Identifiant de contact invalide.", requestId: request.id });
    const parsed = contactUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: "invalid_contact", message: "Vérifiez les champs et la version du contact.", requestId: request.id });
    const organizationScope = await getActiveOrganizationIds(context.supabase, context.userId);
    if (organizationScope.unavailable) return reply.code(503).send({ code: "data_unavailable", message: "Le contact n'est pas disponible.", requestId: request.id });
    const organizationIds = organizationScope.data ?? [];
    if (!organizationIds.length) return reply.code(404).send({ code: "not_found", message: "Contact introuvable.", requestId: request.id });
    const { data: existing, error: readError } = await context.supabase.from("contacts").select("id, organization_id").in("organization_id", organizationIds).eq("id", id.data).is("archived_at", null).maybeSingle();
    if (readError || !existing) return reply.code(404).send({ code: "not_found", message: "Contact introuvable.", requestId: request.id });
    const { data: updatedId, error } = await context.supabase.rpc("update_contact_with_phones", {
      p_contact_id: id.data,
      p_org_id: existing.organization_id,
      p_display_name: parsed.data.displayName,
      p_email: (parsed.data.email ?? null) as unknown as string,
      p_expected_version: parsed.data.version,
      p_phones: parsed.data.phones.map(({ phoneNumber, label }) => ({ phone_number: phoneNumber, label })),
    });
    if (error) return reply.code(error.code === "42501" ? 403 : 503).send({ code: "contact_not_updated", message: "Le contact n'a pas pu être modifié.", requestId: request.id });
    if (!updatedId) return reply.code(409).send({ code: "version_conflict", message: "Ce contact a été modifié ailleurs. Actualisez la fiche puis réessayez.", requestId: request.id });
    const { data } = await context.supabase.from("contacts").select("id, organization_id, display_name, email, version, created_at, contact_phones(id, phone_number, label)").eq("organization_id", existing.organization_id).eq("id", updatedId).single();
    return data ?? { id: updatedId };
  });

  routes.delete<{ Params: { id: string } }>("/v1/contacts/:id", async (request, reply) => {
    const context = request.context;
    const id = uuidSchema.safeParse(request.params.id);
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!id.success) return reply.code(400).send({ code: "invalid_request", message: "Identifiant de contact invalide.", requestId: request.id });
    const organizationScope = await getActiveOrganizationIds(context.supabase, context.userId);
    if (organizationScope.unavailable) return reply.code(503).send({ code: "data_unavailable", message: "Le contact n'est pas disponible.", requestId: request.id });
    const organizationIds = organizationScope.data ?? [];
    if (!organizationIds.length) return reply.code(404).send({ code: "not_found", message: "Contact introuvable.", requestId: request.id });
    const { data, error } = await context.supabase.from("contacts").update({ archived_at: new Date().toISOString() }).in("organization_id", organizationIds).eq("id", id.data).is("archived_at", null).select("id").maybeSingle();
    if (error) return reply.code(503).send({ code: "contact_not_archived", message: "Le contact n'a pas pu être archivé.", requestId: request.id });
    if (!data) return reply.code(404).send({ code: "not_found", message: "Contact introuvable.", requestId: request.id });
    return reply.code(204).send();
  });

  routes.get("/v1/devices", async (request, reply) => {
    const context = request.context;
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    const organizationScope = await getActiveOrganizationIds(context.supabase, context.userId);
    if (organizationScope.unavailable) return reply.code(503).send({ code: "data_unavailable", message: "Les appareils ne sont pas disponibles.", requestId: request.id });
    const organizationIds = organizationScope.data ?? [];
    if (!organizationIds.length) return { items: [] };
    const { data, error } = await context.supabase.from("devices").select("id, organization_id, platform, label, status, last_active_at, created_at").in("organization_id", organizationIds).eq("user_id", context.userId).order("created_at", { ascending: false }).limit(50);
    if (error) return reply.code(503).send({ code: "data_unavailable", message: "Les appareils ne sont pas disponibles.", requestId: request.id });
    return { items: data ?? [] };
  });

  routes.post("/v1/devices", async (request, reply) => {
    const context = request.context;
    const parsed = deviceCreateSchema.safeParse(request.body);
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!parsed.success) return reply.code(400).send({ code: "invalid_device", message: "Vérifiez la plateforme et le nom de l'appareil.", requestId: request.id });
    const identityPrefix = parsed.data.platform === "ios" || parsed.data.platform === "android" ? "mobile" : parsed.data.platform;
    const { data, error } = await context.supabase.from("devices").insert({
      organization_id: parsed.data.organizationId,
      user_id: context.userId,
      platform: parsed.data.platform,
      label: parsed.data.label,
      voice_identity: `${identityPrefix}_${randomUUID().replaceAll("-", "")}`,
      status: "active",
    }).select("id, organization_id, platform, label, status, last_active_at, created_at").single();
    if (error || !data) return reply.code(error?.code === "42501" ? 403 : 400).send({ code: "device_not_created", message: "L'appareil ne peut pas être enregistré dans cette organisation.", requestId: request.id });
    return reply.code(201).send(data);
  });

  routes.put<{ Params: { id: string }; Body: { registered: boolean } }>("/v1/devices/:id/voice-state", async (request, reply) => {
    const context = request.context;
    const id = uuidSchema.safeParse(request.params.id);
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!id.success || !request.body || typeof request.body.registered !== "boolean") {
      return reply.code(400).send({ code: "invalid_request", message: "Identifiant ou état vocal invalide.", requestId: request.id });
    }
    const { error } = await context.supabase.rpc("set_device_voice_state", {
      p_device_id: id.data,
      p_registered: request.body.registered,
    });
    if (error) {
      request.log.warn({ code: error.code, requestId: request.id }, "device voice state could not be updated");
      const status = error.code === "42501" ? 403 : error.code === "22023" ? 400 : 503;
      return reply.code(status).send({ code: "device_voice_state_unavailable", message: "L’état vocal de cet appareil n’a pas pu être mis à jour.", requestId: request.id });
    }
    request.log.info({ requestId: request.id, userId: context.userId, deviceId: id.data, registered: request.body.registered }, "device voice registration state updated");
    return { id: id.data, registered: request.body.registered };
  });

  routes.post("/v1/voice/token", async (request, reply) => {
    const context = request.context;
    const parsed = voiceTargetSchema.safeParse(request.body);
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!parsed.success) return reply.code(400).send({ code: "invalid_voice_target", message: "Ligne ou appareil invalide.", requestId: request.id });
    if (!config.VOICE_ENABLED || !config.TWILIO_ACCOUNT_SID || !config.TWILIO_API_KEY_SID || !config.TWILIO_API_KEY_SECRET || !config.TWILIO_TWIML_APP_SID) {
      return reply.code(503).send({ code: "voice_disabled", message: "Le service vocal n’est pas configuré dans cet environnement.", requestId: request.id });
    }

    const [{ data: assignment, error: assignmentError }, { data: device, error: deviceError }, { data: line, error: lineError }] = await Promise.all([
      context.supabase.from("line_assignments").select("id, can_voice, status").eq("organization_id", parsed.data.organizationId).eq("line_id", parsed.data.lineId).eq("user_id", context.userId).eq("status", "active").maybeSingle(),
      context.supabase.from("devices").select("id, voice_identity, platform, status").eq("id", parsed.data.deviceId).eq("organization_id", parsed.data.organizationId).eq("user_id", context.userId).eq("status", "active").maybeSingle(),
      context.supabase.from("lines").select("id, status, voice_enabled").eq("id", parsed.data.lineId).eq("organization_id", parsed.data.organizationId).maybeSingle(),
    ]);
    if (assignmentError || deviceError || lineError) return reply.code(503).send({ code: "voice_unavailable", message: "Les autorisations vocales ne sont pas disponibles.", requestId: request.id });
    if (!assignment?.can_voice || !device || !line || line.status !== "active" || !line.voice_enabled) {
      return reply.code(403).send({ code: "voice_forbidden", message: "Cet appareil n’a pas accès à cette ligne vocale.", requestId: request.id });
    }
    const tokenAllowed = await consumeUserRateLimit(context.userId, "voice_token", 60, 30);
    if (tokenAllowed === null) return reply.code(503).send({ code: "voice_unavailable", message: "Les limites vocales ne sont pas disponibles.", requestId: request.id });
    if (!tokenAllowed) return reply.code(429).send({ code: "voice_token_rate_limited", message: "Trop de demandes de token vocal. Réessayez dans une minute.", requestId: request.id });

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const pushCredentialSid = device.platform === "ios"
      ? config.TWILIO_PUSH_CREDENTIAL_SID_IOS
      : device.platform === "android" ? config.TWILIO_PUSH_CREDENTIAL_SID_ANDROID : undefined;
    const token = createVoiceAccessToken({
      accountSid: config.TWILIO_ACCOUNT_SID,
      apiKeySid: config.TWILIO_API_KEY_SID,
      apiKeySecret: config.TWILIO_API_KEY_SECRET,
      twimlAppSid: config.TWILIO_TWIML_APP_SID,
      ...(pushCredentialSid ? { pushCredentialSid } : {}),
    }, device.voice_identity);
    request.log.info({ requestId: request.id, userId: context.userId, organizationId: parsed.data.organizationId, deviceId: device.id, lineId: line.id }, "voice token issued");
    return { token, identity: device.voice_identity, expiresAt, incomingEnabled: device.platform === "web" || Boolean(pushCredentialSid) };
  });

  routes.post("/v1/call-intents", async (request, reply) => {
    const context = request.context;
    const parsed = callIntentCreateSchema.safeParse(request.body);
    const idempotencyKey = request.headers["idempotency-key"];
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!parsed.success) return reply.code(400).send({ code: "invalid_call", message: "Vérifiez la ligne et le numéro de destination.", requestId: request.id });
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      return reply.code(400).send({ code: "idempotency_key_required", message: "Une clé d’action valide est requise.", requestId: request.id });
    }
    if (config.OPERATIONS_PAUSED) return reply.code(503).send({ code: "operations_paused", message: config.OPERATIONS_PAUSE_MESSAGE, requestId: request.id });
    if (!config.VOICE_ENABLED) return reply.code(503).send({ code: "voice_disabled", message: "Les appels sont désactivés dans cet environnement.", requestId: request.id });
    const allowedPrefixes = config.TWILIO_ALLOWED_DESTINATIONS.split(",").map((prefix) => prefix.trim()).filter(Boolean);
    if (!allowedPrefixes.some((prefix) => parsed.data.destination.startsWith(prefix))) {
      return reply.code(403).send({ code: "destination_not_allowed", message: "Cette destination n’est pas autorisée pour les essais.", requestId: request.id });
    }
    const callAllowed = await consumeUserRateLimit(context.userId, "call_intent", 60, 5);
    if (callAllowed === null) return reply.code(503).send({ code: "voice_unavailable", message: "Les limites vocales ne sont pas disponibles.", requestId: request.id });
    if (!callAllowed) return reply.code(429).send({ code: "call_rate_limited", message: "Trop de tentatives d’appel. Réessayez dans une minute.", requestId: request.id });
    const { data, error } = await context.supabase.rpc("issue_call_intent", {
      p_org_id: parsed.data.organizationId,
      p_line_id: parsed.data.lineId,
      p_device_id: parsed.data.deviceId,
      p_destination: parsed.data.destination,
      p_idempotency_key: idempotencyKey,
      p_request_hash: createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex"),
      p_max_active_seconds: config.MAX_ACTIVE_CALL_SECONDS,
    });
    if (error) {
      request.log.warn({ code: error.code, requestId: request.id, lineId: parsed.data.lineId }, "call intent rejected");
      if (error.code === "42501") return reply.code(403).send({ code: "call_forbidden", message: "Cette ligne ou cette destination n’est pas autorisée.", requestId: request.id });
      if (error.code === "55000") return reply.code(409).send({ code: "call_already_active", message: "Terminez l’appel actif avant d’en lancer un autre.", requestId: request.id });
      if (error.code === "54000") return reply.code(429).send({ code: "call_limit_reached", message: "Le plafond quotidien d’appels de démonstration est atteint.", requestId: request.id });
      if (error.code === "22023") return reply.code(409).send({ code: "idempotency_conflict", message: "Cette clé a déjà été utilisée avec d’autres données.", requestId: request.id });
      return reply.code(503).send({ code: "call_not_started", message: "L’appel n’a pas pu être préparé.", requestId: request.id });
    }
    request.log.info({ requestId: request.id, userId: context.userId, organizationId: parsed.data.organizationId, lineId: parsed.data.lineId, intentId: data }, "call intent issued");
    return reply.code(201).send({ id: data, status: "issued" });
  });

  routes.post<{ Params: { id: string } }>("/v1/call-intents/:id/cancel", async (request, reply) => {
    const context = request.context;
    const id = uuidSchema.safeParse(request.params.id);
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!id.success) return reply.code(400).send({ code: "invalid_call_intent", message: "Identifiant d'intention invalide.", requestId: request.id });
    if (!serviceSupabase) return reply.code(503).send({ code: "call_intent_unavailable", message: "La réservation d'appel n'est pas disponible.", requestId: request.id });
    const { data, error } = await serviceSupabase.rpc("cancel_call_intent", {
      p_intent_id: id.data,
      p_user_id: context.userId,
    });
    if (error || !data || typeof data !== "object" || Array.isArray(data)) {
      request.log.warn({ code: error?.code, requestId: request.id }, "call intent cancellation failed");
      return reply.code(503).send({ code: "call_intent_unavailable", message: "L'intention d'appel n'a pas pu être annulée.", requestId: request.id });
    }
    const result = data as { canceled?: boolean; status?: string };
    if (result.status === "not_found") return reply.code(404).send({ code: "call_intent_not_found", message: "Cette intention d'appel n'existe pas.", requestId: request.id });
    if (!result.canceled) return reply.code(result.status === "expired" ? 410 : 409).send({ code: `call_intent_${result.status ?? "unavailable"}`, message: "Cette intention ne peut plus être annulée.", requestId: request.id });
    request.log.info({ requestId: request.id, userId: context.userId, intentId: id.data }, "call intent canceled");
    return reply.send({ id: id.data, status: "canceled" });
  });

  routes.post("/webhooks/twilio/voice/outbound", async (request, reply) => {
    reply.type("text/xml; charset=utf-8");
    if (!validateTwilioWebhook(request)) return reply.code(403).send("<Response><Hangup/></Response>");
    const body = request.body as Record<string, string>;
    const intentId = uuidSchema.safeParse(body.CallIntentId);
    const voiceIdentity = body.From?.startsWith("client:") ? body.From.slice("client:".length) : "";
    if (!intentId.success || !voiceIdentity || typeof body.AccountSid !== "string" || body.AccountSid !== config.TWILIO_ACCOUNT_SID || !/^CA[0-9a-fA-F]{32}$/.test(body.CallSid ?? "")) {
      return reply.code(400).send("<Response><Hangup/></Response>");
    }
    if (!config.VOICE_ENABLED || !serviceSupabase || !config.TWILIO_ACCOUNT_SID) return reply.code(503).send("<Response><Hangup/></Response>");

    const { data, error } = await serviceSupabase.rpc("consume_call_intent", {
      p_intent_id: intentId.data,
      p_call_sid: body.CallSid!,
      p_voice_identity: voiceIdentity,
      p_account_sid: body.AccountSid,
    });
    if (error || !data || typeof data !== "object" || Array.isArray(data)) {
      request.log.warn({ code: error?.code, requestId: request.id }, "outbound voice intent unavailable");
      if (error?.code === "42501" || error?.code === "22023" || error?.code === "P0002") {
        return reply.send("<Response><Say language=\"fr-FR\">Cet appel n’est plus autorisé.</Say><Hangup/></Response>");
      }
      return reply.code(503).send("<Response><Hangup/></Response>");
    }
    const call = data as { callerId?: string; destination?: string; callId?: string; organizationId?: string; lineId?: string; callSid?: string; duplicate?: boolean };
    if (!call.callerId || !call.destination) return reply.code(503).send("<Response><Hangup/></Response>");
    request.log.info({ requestId: request.id, organizationId: call.organizationId, lineId: call.lineId, callId: call.callId, callSid: call.callSid ?? body.CallSid, duplicate: call.duplicate === true }, "outbound voice call routed");

    const callbackBase = config.API_PUBLIC_URL.replace(/\/$/, "");
    const voice = new twilio.twiml.VoiceResponse();
    const dial = voice.dial({
      callerId: call.callerId,
      answerOnBridge: true,
      timeout: 30,
      timeLimit: config.MAX_ACTIVE_CALL_SECONDS,
      action: `${callbackBase}/webhooks/twilio/voice/dial-action`,
      method: "POST",
    });
    dial.number({
      statusCallback: `${callbackBase}/webhooks/twilio/voice/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    }, call.destination);
    return reply.send(voice.toString());
  });

  routes.post("/webhooks/twilio/voice/inbound", async (request, reply) => {
    reply.type("text/xml; charset=utf-8");
    if (!validateTwilioWebhook(request)) return reply.code(403).send("<Response><Hangup/></Response>");
    const body = request.body as Record<string, string>;
    if (typeof body.AccountSid !== "string" || body.AccountSid !== config.TWILIO_ACCOUNT_SID
        || !/^CA[0-9a-fA-F]{32}$/.test(body.CallSid ?? "")
        || !/^\+[1-9]\d{7,14}$/.test(body.From ?? "")
        || !/^\+[1-9]\d{7,14}$/.test(body.To ?? "")) {
      return reply.code(400).send("<Response><Hangup/></Response>");
    }
    if (!config.VOICE_ENABLED || !serviceSupabase) return reply.code(503).send("<Response><Hangup/></Response>");

    const { data, error } = await serviceSupabase.rpc("begin_inbound_call", {
      p_account_sid: body.AccountSid,
      p_call_sid: body.CallSid!,
      p_from: body.From!,
      p_to: body.To!,
      p_max_ringing_devices: config.MAX_RINGING_DEVICES,
    });
    if (error || !data || typeof data !== "object" || Array.isArray(data)) {
      request.log.warn({ code: error?.code, requestId: request.id }, "inbound voice routing unavailable");
      return reply.code(503).send("<Response><Hangup/></Response>");
    }
    const routing = data as { allowed?: boolean; duplicate?: boolean; callId?: string; organizationId?: string; lineId?: string; callerNumber?: string; devices?: { deviceId: string; identity: string }[] };
    request.log.info({ requestId: request.id, organizationId: routing.organizationId, lineId: routing.lineId, callId: routing.callId, callSid: body.CallSid, allowed: routing.allowed === true, duplicate: routing.duplicate === true, ringingDeviceCount: routing.devices?.length ?? 0 }, "inbound voice call routed");
    const voice = new twilio.twiml.VoiceResponse();
    if (!routing.allowed) {
      voice.say({ language: "fr-FR" }, "Cette ligne n’est pas disponible.");
      voice.hangup();
      return reply.send(voice.toString());
    }
    if (!routing.devices?.length || !routing.callId) {
      voice.say({ language: "fr-FR" }, "Aucun appareil n’est disponible pour répondre.");
      voice.hangup();
      return reply.send(voice.toString());
    }

    const callbackBase = config.API_PUBLIC_URL.replace(/\/$/, "");
    const dial = voice.dial({
      timeout: 30,
      answerOnBridge: true,
      timeLimit: config.MAX_ACTIVE_CALL_SECONDS,
      action: `${callbackBase}/webhooks/twilio/voice/dial-action`,
      method: "POST",
    });
    for (const device of routing.devices) {
      const client = dial.client({
        statusCallback: `${callbackBase}/webhooks/twilio/voice/status`,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      }, device.identity);
      client.parameter({ name: "CallId", value: routing.callId });
      client.parameter({ name: "From", value: routing.callerNumber ?? body.From! });
    }
    return reply.send(voice.toString());
  });

  routes.post("/webhooks/twilio/voice/status", async (request, reply) => {
    if (!validateTwilioWebhook(request)) return reply.code(403).send({ code: "invalid_signature" });
    const body = request.body as Record<string, string>;
    if (typeof body.AccountSid !== "string" || body.AccountSid !== config.TWILIO_ACCOUNT_SID) return reply.code(403).send({ code: "invalid_account" });
    const callSid = body.CallSid ?? "";
    if (!serviceSupabase) return reply.code(503).send({ code: "webhook_storage_unavailable" });
    const duration = body.CallDuration === undefined ? null : Number(body.CallDuration);
    const providerTimestamp = body.Timestamp ? Date.parse(body.Timestamp) : Number.NaN;
    const sequenceNumber = body.SequenceNumber && /^\d+$/.test(body.SequenceNumber)
      ? Number(body.SequenceNumber)
      : Number.NaN;
    const statusArgs = {
      p_account_sid: body.AccountSid,
      p_call_sid: callSid,
      p_parent_call_sid: body.ParentCallSid || callSid,
      p_call_status: body.CallStatus ?? "",
      p_call_duration: Number.isInteger(duration) ? duration : null,
      p_provider_event_at: Number.isFinite(providerTimestamp) ? new Date(providerTimestamp).toISOString() : null,
      p_provider_sequence_number: Number.isSafeInteger(sequenceNumber) && sequenceNumber <= 2_147_483_647 ? sequenceNumber : null,
    };
    const { data: applied, error } = await serviceSupabase.rpc("apply_call_status", statusArgs);
    if (error) {
      request.log.warn({ code: error.code, requestId: request.id }, "voice status event deferred");
      return reply.code(503).send({ code: "status_not_recorded" });
    }
    const callOutcome = applied && typeof applied === "object" && !Array.isArray(applied)
      ? applied as { callId?: string; status?: string; duplicate?: boolean; ignored?: boolean }
      : {};
    const providerEventLagMs = statusArgs.p_provider_event_at ? Math.max(0, Date.now() - Date.parse(statusArgs.p_provider_event_at)) : undefined;
    request.log.info({ requestId: request.id, callId: callOutcome.callId, callSid, parentCallSid: statusArgs.p_parent_call_sid, providerStatus: statusArgs.p_call_status, providerEventAt: statusArgs.p_provider_event_at, providerEventLagMs, duplicate: callOutcome.duplicate === true, ignored: callOutcome.ignored === true }, "voice status event processed");
    const clientTarget = body.To?.startsWith("client:") ? body.To.slice("client:".length) : "";
    if ((body.CallStatus === "in-progress" || body.CallStatus === "completed")
        && clientTarget.length > 0 && clientTarget.length <= 121) {
      const { error: deviceError } = await serviceSupabase.rpc("record_answered_call_device", {
        p_account_sid: body.AccountSid,
        p_call_sid: callSid,
        p_voice_identity: clientTarget,
      });
      if (deviceError) {
        request.log.warn({ code: deviceError.code, requestId: request.id }, "answered call device event deferred");
        return reply.code(503).send({ code: "device_not_recorded" });
      }
    }
    return reply.code(204).send();
  });

  routes.post("/webhooks/twilio/voice/dial-action", async (request, reply) => {
    if (!validateTwilioWebhook(request)) return reply.code(403).send("<Response><Hangup/></Response>");
    const body = request.body as Record<string, string>;
    if (typeof body.AccountSid !== "string" || body.AccountSid !== config.TWILIO_ACCOUNT_SID) return reply.code(403).send("<Response><Hangup/></Response>");
    if (!serviceSupabase) return reply.code(503).send("<Response><Hangup/></Response>");
    const dialDuration = body.DialCallDuration === undefined ? Number.NaN : Number(body.DialCallDuration);
    const dialStatus = body.DialCallStatus === "answered" ? "completed" : body.DialCallStatus ?? "failed";
    const completedChildSid = dialStatus === "completed" && /^CA[0-9a-fA-F]{32}$/.test(body.DialCallSid ?? "")
      ? body.DialCallSid!
      : null;
    const { data: applied, error } = await serviceSupabase.rpc("apply_call_status", {
      p_account_sid: body.AccountSid,
      p_call_sid: completedChildSid ?? body.CallSid ?? "",
      p_parent_call_sid: body.CallSid ?? "",
      p_call_status: dialStatus,
      p_call_duration: Number.isInteger(dialDuration) ? dialDuration : null,
      p_provider_event_at: null,
      p_provider_sequence_number: null,
    });
    if (error) {
      request.log.warn({ code: error.code, requestId: request.id }, "dial outcome could not be stored");
      return reply.code(503).send("<Response><Hangup/></Response>");
    }
    const callOutcome = applied && typeof applied === "object" && !Array.isArray(applied)
      ? applied as { callId?: string; status?: string; duplicate?: boolean; ignored?: boolean }
      : {};
    request.log.info({ requestId: request.id, callId: callOutcome.callId, callSid: completedChildSid ?? body.CallSid, parentCallSid: body.CallSid, providerStatus: dialStatus, duplicate: callOutcome.duplicate === true, ignored: callOutcome.ignored === true }, "dial outcome processed");
    const voice = new twilio.twiml.VoiceResponse();
    voice.hangup();
    return reply.type("text/xml; charset=utf-8").send(voice.toString());
  });

  routes.post<{ Params: { id: string } }>("/v1/devices/:id/revoke", async (request, reply) => {
    const context = request.context;
    const id = uuidSchema.safeParse(request.params.id);
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!id.success) return reply.code(400).send({ code: "invalid_request", message: "Identifiant d'appareil invalide.", requestId: request.id });
    const { data, error } = await context.supabase.from("devices").update({ status: "revoked", revoked_at: new Date().toISOString() }).eq("id", id.data).eq("user_id", context.userId).eq("status", "active").select("id").maybeSingle();
    if (error) return reply.code(503).send({ code: "device_not_revoked", message: "L'appareil n'a pas pu être révoqué.", requestId: request.id });
    if (!data) return reply.code(404).send({ code: "not_found", message: "Appareil introuvable.", requestId: request.id });
    return { id: data.id, status: "revoked" };
  });

  routes.get<{ Params: { orgId: string } }>("/v1/organizations/:orgId/lines", async (request, reply) => {
    const context = request.context;
    const orgId = uuidSchema.safeParse(request.params.orgId);
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!orgId.success) return reply.code(400).send({ code: "invalid_request", message: "Organisation invalide.", requestId: request.id });
    const { data, error } = await context.supabase.from("line_assignments").select("can_voice, can_sms, lines(id, organization_id, phone_number, voice_enabled, sms_enabled)").eq("organization_id", orgId.data).eq("user_id", context.userId).eq("status", "active");
    if (error) throw new Error("Impossible de charger les lignes autorisées.");
    return { items: data };
  });

  routes.put<{ Params: { orgId: string; lineId: string; userId: string } }>("/v1/organizations/:orgId/lines/:lineId/assignments/:userId", async (request, reply) => {
    const context = request.context;
    const orgId = uuidSchema.safeParse(request.params.orgId);
    const lineId = uuidSchema.safeParse(request.params.lineId);
    const userId = uuidSchema.safeParse(request.params.userId);
    const parsed = lineAssignmentUpdateSchema.safeParse(request.body);
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!orgId.success || !lineId.success || !userId.success || !parsed.success) {
      return reply.code(400).send({ code: "invalid_assignment", message: "L'organisation, la ligne, le membre ou les droits sont invalides.", requestId: request.id });
    }
    const admin = await isActiveOrganizationAdmin(context.supabase, context.userId, orgId.data);
    if (admin.unavailable) return reply.code(503).send({ code: "data_unavailable", message: "L'affectation de ligne n'est pas disponible.", requestId: request.id });
    if (!admin.data) return reply.code(403).send({ code: "assignment_forbidden", message: "Seul un administrateur actif peut affecter une ligne.", requestId: request.id });
    if (!serviceSupabase) return reply.code(503).send({ code: "assignment_unavailable", message: "L'affectation de ligne n'est pas configurée.", requestId: request.id });

    const assignment = await persistLineAssignment(serviceSupabase, {
      organizationId: orgId.data,
      lineId: lineId.data,
      userId: userId.data,
      actorId: context.userId,
      canVoice: parsed.data.canVoice,
      canSms: parsed.data.canSms,
      revoke: false,
    });
    if (assignment.errorCode) {
      request.log.warn({ code: assignment.errorCode, requestId: request.id, organizationId: orgId.data, lineId: lineId.data }, "line assignment update failed");
      const status = assignment.errorCode === "42501" ? 403 : assignment.errorCode === "23503" ? 404 : assignment.errorCode === "22023" ? 400 : 503;
      return reply.code(status).send({ code: "assignment_not_updated", message: "L'affectation n'a pas pu être mise à jour.", requestId: request.id });
    }
    if (!assignment.id) return reply.code(404).send({ code: "assignment_target_not_found", message: "La ligne ou le membre est introuvable ou inactif.", requestId: request.id });
    request.log.info({ requestId: request.id, actorUserId: context.userId, organizationId: orgId.data, lineId: lineId.data, targetUserId: userId.data, assignmentId: assignment.id }, "line assignment updated");
    return { id: assignment.id, status: "active" as const };
  });

  routes.delete<{ Params: { orgId: string; lineId: string; userId: string } }>("/v1/organizations/:orgId/lines/:lineId/assignments/:userId", async (request, reply) => {
    const context = request.context;
    const orgId = uuidSchema.safeParse(request.params.orgId);
    const lineId = uuidSchema.safeParse(request.params.lineId);
    const userId = uuidSchema.safeParse(request.params.userId);
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!orgId.success || !lineId.success || !userId.success) return reply.code(400).send({ code: "invalid_assignment", message: "L'organisation, la ligne ou le membre est invalide.", requestId: request.id });
    const admin = await isActiveOrganizationAdmin(context.supabase, context.userId, orgId.data);
    if (admin.unavailable) return reply.code(503).send({ code: "data_unavailable", message: "L'affectation de ligne n'est pas disponible.", requestId: request.id });
    if (!admin.data) return reply.code(403).send({ code: "assignment_forbidden", message: "Seul un administrateur actif peut révoquer une affectation.", requestId: request.id });
    if (!serviceSupabase) return reply.code(503).send({ code: "assignment_unavailable", message: "L'affectation de ligne n'est pas configurée.", requestId: request.id });

    const assignment = await persistLineAssignment(serviceSupabase, {
      organizationId: orgId.data,
      lineId: lineId.data,
      userId: userId.data,
      actorId: context.userId,
      canVoice: false,
      canSms: false,
      revoke: true,
    });
    if (assignment.errorCode) {
      request.log.warn({ code: assignment.errorCode, requestId: request.id, organizationId: orgId.data, lineId: lineId.data }, "line assignment revocation failed");
      const status = assignment.errorCode === "42501" ? 403 : assignment.errorCode === "23503" ? 404 : assignment.errorCode === "22023" ? 400 : 503;
      return reply.code(status).send({ code: "assignment_not_revoked", message: "L'affectation n'a pas pu être révoquée.", requestId: request.id });
    }
    if (!assignment.id) return reply.code(404).send({ code: "assignment_not_found", message: "L'affectation est introuvable.", requestId: request.id });
    request.log.info({ requestId: request.id, actorUserId: context.userId, organizationId: orgId.data, lineId: lineId.data, targetUserId: userId.data, assignmentId: assignment.id }, "line assignment revoked");
    return { id: assignment.id, status: "revoked" as const };
  });

  routes.get<{ Params: { lineId: string }; Querystring: { limit?: string; cursor?: string } }>("/v1/lines/:lineId/calls", async (request, reply) => {
    const context = request.context;
    const lineId = uuidSchema.safeParse(request.params.lineId);
    const page = paginationSchema.safeParse(request.query);
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!lineId.success || !page.success) return reply.code(400).send({ code: "invalid_request", message: "Ligne ou pagination invalide.", requestId: request.id });
    const cursor = decodeCursor(page.data.cursor);
    if (cursor === false) return reply.code(400).send({ code: "invalid_request", message: "Curseur invalide.", requestId: request.id });
    const scope = await findAssignedLine(context.supabase, context.userId, lineId.data, "can_voice");
    if (scope.unavailable) return reply.code(503).send({ code: "data_unavailable", message: "L'historique n'est pas disponible.", requestId: request.id });
    if (!scope.data) return reply.code(404).send({ code: "not_found", message: "Ligne introuvable.", requestId: request.id });
    let query = context.supabase.from("calls").select("id, organization_id, line_id, direction, remote_number, status, started_at, answered_at, ended_at, duration_seconds, created_at").eq("organization_id", scope.data.organizationId).eq("line_id", scope.data.lineId).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(page.data.limit + 1);
    if (cursor) query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
    const { data, error } = await query;
    if (error) return reply.code(503).send({ code: "data_unavailable", message: "L'historique n'est pas disponible.", requestId: request.id });
    const items = data ?? [];
    const hasMore = items.length > page.data.limit;
    if (hasMore) items.pop();
    let contactNames = new Map<string, string>();
    if (items.length) {
      try {
        contactNames = await resolveUniqueContactNames(context.supabase, items[0]!.organization_id, items.map((call) => call.remote_number));
      } catch {
        request.log.warn({ requestId: request.id }, "call contact labels unavailable");
      }
    }
    return {
      items: items.map((call) => ({ ...call, remoteContactName: contactNames.get(call.remote_number) ?? null })),
      nextCursor: hasMore && items.length ? encodeCursor(items[items.length - 1]!) : null,
    };
  });

  routes.get<{ Params: { lineId: string }; Querystring: { limit?: string; cursor?: string } }>("/v1/lines/:lineId/conversations", async (request, reply) => {
    const context = request.context;
    const lineId = uuidSchema.safeParse(request.params.lineId);
    const page = paginationSchema.safeParse(request.query);
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!lineId.success || !page.success) return reply.code(400).send({ code: "invalid_request", message: "Ligne ou pagination invalide.", requestId: request.id });
    const cursor = decodeCursor(page.data.cursor);
    if (cursor === false) return reply.code(400).send({ code: "invalid_request", message: "Curseur invalide.", requestId: request.id });
    const scope = await findAssignedLine(context.supabase, context.userId, lineId.data, "can_sms");
    if (scope.unavailable) return reply.code(503).send({ code: "data_unavailable", message: "Les conversations ne sont pas disponibles.", requestId: request.id });
    if (!scope.data) return reply.code(404).send({ code: "not_found", message: "Ligne introuvable.", requestId: request.id });
    let query = context.supabase.from("conversations").select("id, organization_id, line_id, remote_number, last_message_at")
      .not("last_message_at", "is", null)
      .eq("organization_id", scope.data.organizationId).eq("line_id", scope.data.lineId).order("last_message_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false }).limit(page.data.limit + 1);
    if (cursor) query = query.or(`last_message_at.lt.${cursor.createdAt},and(last_message_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
    const { data, error } = await query;
    if (error) return reply.code(503).send({ code: "data_unavailable", message: "Les conversations ne sont pas disponibles.", requestId: request.id });
    const conversations = data ?? [];
    const hasMore = conversations.length > page.data.limit;
    if (hasMore) conversations.pop();
    const ids = conversations.map((conversation) => conversation.id);
    let latestByConversation = new Map<string, { id: string; body: string; direction: string; status: string; created_at: string }>();
    if (ids.length) {
      const { data: messages, error: messageError } = await context.supabase.rpc("latest_conversation_messages", {
        p_line_id: lineId.data,
        p_conversation_ids: ids,
      });
      if (messageError) return reply.code(503).send({ code: "data_unavailable", message: "Les derniers messages ne sont pas disponibles.", requestId: request.id });
      latestByConversation = new Map((messages ?? []).map((message) => [message.conversation_id, message]));
    }
    let unreadByConversation = new Map<string, boolean>();
    if (ids.length) {
      const { data: unreadStatuses, error: unreadError } = await context.supabase.rpc("conversation_unread_status", {
        p_line_id: lineId.data,
        p_conversation_ids: ids,
      });
      if (unreadError) return reply.code(503).send({ code: "data_unavailable", message: "Les états de lecture ne sont pas disponibles.", requestId: request.id });
      unreadByConversation = new Map((unreadStatuses ?? []).map((status) => [status.conversation_id, status.unread]));
    }
    let contactNames = new Map<string, string>();
    if (conversations.length) {
      try {
        contactNames = await resolveUniqueContactNames(context.supabase, conversations[0]!.organization_id, conversations.map((conversation) => conversation.remote_number));
      } catch {
        request.log.warn({ requestId: request.id }, "conversation contact labels unavailable");
      }
    }
    const items = conversations.map((conversation) => ({
      id: conversation.id,
      lineId: conversation.line_id,
      remoteNumber: conversation.remote_number,
      remoteContactName: contactNames.get(conversation.remote_number) ?? null,
      lastMessageAt: conversation.last_message_at,
      lastMessage: latestByConversation.get(conversation.id) ?? null,
      unread: unreadByConversation.get(conversation.id) ?? false,
    }));
    const lastConversation = conversations[conversations.length - 1];
    return { items, nextCursor: hasMore && lastConversation?.last_message_at ? encodeCursor({ last_message_at: lastConversation.last_message_at, id: lastConversation.id }) : null };
  });

  routes.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>("/v1/conversations/:id/messages", async (request, reply) => {
    const context = request.context;
    const conversationId = uuidSchema.safeParse(request.params.id);
    const page = paginationSchema.safeParse(request.query);
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!conversationId.success || !page.success) return reply.code(400).send({ code: "invalid_request", message: "Conversation ou pagination invalide.", requestId: request.id });
    const cursor = decodeCursor(page.data.cursor);
    if (cursor === false) return reply.code(400).send({ code: "invalid_request", message: "Curseur invalide.", requestId: request.id });
    const organizationScope = await getActiveOrganizationIds(context.supabase, context.userId);
    if (organizationScope.unavailable) return reply.code(503).send({ code: "data_unavailable", message: "La conversation n'est pas disponible.", requestId: request.id });
    const organizationIds = organizationScope.data ?? [];
    if (!organizationIds.length) return reply.code(404).send({ code: "not_found", message: "Conversation introuvable.", requestId: request.id });
    const { data: conversation, error: conversationError } = await context.supabase.from("conversations")
      .select("id, organization_id, line_id, remote_number").in("organization_id", organizationIds).eq("id", conversationId.data).maybeSingle();
    if (conversationError) return reply.code(503).send({ code: "data_unavailable", message: "La conversation n'est pas disponible.", requestId: request.id });
    if (!conversation) return reply.code(404).send({ code: "not_found", message: "Conversation introuvable.", requestId: request.id });
    const lineScope = await findAssignedLine(context.supabase, context.userId, conversation.line_id, "can_sms");
    if (lineScope.unavailable) return reply.code(503).send({ code: "data_unavailable", message: "La conversation n'est pas disponible.", requestId: request.id });
    if (!lineScope.data || lineScope.data.organizationId !== conversation.organization_id) return reply.code(404).send({ code: "not_found", message: "Conversation introuvable.", requestId: request.id });
    let query = context.supabase.from("messages").select("id, conversation_id, direction, body, status, provider_error_code, created_at, sent_at, delivered_at")
      .eq("organization_id", conversation.organization_id).eq("conversation_id", conversation.id).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(page.data.limit + 1);
    if (cursor) query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
    const { data, error } = await query;
    if (error) return reply.code(503).send({ code: "data_unavailable", message: "Les messages ne sont pas disponibles.", requestId: request.id });
    const items = data ?? [];
    const hasMore = items.length > page.data.limit;
    if (hasMore) items.pop();
    const nextCursor = hasMore && items.length ? encodeCursor(items[items.length - 1]!) : null;
    return { conversation, items: items.reverse(), nextCursor };
  });

  routes.put<{ Params: { id: string }; Body: { lastReadMessageId?: string | null } }>("/v1/conversations/:id/read", async (request, reply) => {
    const context = request.context;
    const conversationId = uuidSchema.safeParse(request.params.id);
    const lastReadMessageId = request.body?.lastReadMessageId == null ? null : uuidSchema.safeParse(request.body.lastReadMessageId);
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!conversationId.success || (lastReadMessageId !== null && !lastReadMessageId.success)) {
      return reply.code(400).send({ code: "invalid_request", message: "Conversation ou message invalide.", requestId: request.id });
    }
    const organizationScope = await getActiveOrganizationIds(context.supabase, context.userId);
    if (organizationScope.unavailable) return reply.code(503).send({ code: "data_unavailable", message: "La conversation n'est pas disponible.", requestId: request.id });
    const organizationIds = organizationScope.data ?? [];
    if (!organizationIds.length) return reply.code(404).send({ code: "not_found", message: "Conversation introuvable.", requestId: request.id });
    const { data: conversation } = await context.supabase.from("conversations").select("id, organization_id, line_id").in("organization_id", organizationIds).eq("id", conversationId.data).maybeSingle();
    if (!conversation) return reply.code(404).send({ code: "not_found", message: "Conversation introuvable.", requestId: request.id });
    const lineScope = await findAssignedLine(context.supabase, context.userId, conversation.line_id, "can_sms");
    if (lineScope.unavailable) return reply.code(503).send({ code: "data_unavailable", message: "L'état de lecture n'a pas pu être enregistré.", requestId: request.id });
    if (!lineScope.data || lineScope.data.organizationId !== conversation.organization_id) return reply.code(404).send({ code: "not_found", message: "Conversation introuvable.", requestId: request.id });
    const messageId = lastReadMessageId?.success ? lastReadMessageId.data : null;
    if (messageId) {
      const { data: message } = await context.supabase.from("messages").select("id").eq("organization_id", conversation.organization_id).eq("id", messageId).eq("conversation_id", conversation.id).maybeSingle();
      if (!message) return reply.code(400).send({ code: "invalid_request", message: "Le message n'appartient pas à cette conversation.", requestId: request.id });
    }
    const { error } = await context.supabase.from("conversation_reads").upsert({
      organization_id: conversation.organization_id,
      conversation_id: conversation.id,
      user_id: context.userId,
      last_read_message_id: messageId,
    }, { onConflict: "conversation_id,user_id" });
    if (error) return reply.code(403).send({ code: "read_state_not_updated", message: "L'état de lecture n'a pas pu être enregistré.", requestId: request.id });
    return reply.code(204).send();
  });

  routes.get("/v1/messages/pending", async (request, reply) => {
    const context = request.context;
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    const { data, error } = await context.supabase.rpc("list_pending_outbound_messages");
    if (error) return reply.code(503).send({ code: "pending_messages_unavailable", message: "Les envois à vérifier ne sont pas disponibles.", requestId: request.id });
    return { items: data ?? [] };
  });

  routes.post("/v1/messages", async (request, reply) => {
    const context = request.context;
    const parsed = messageCreateSchema.safeParse(request.body);
    const idempotencyKey = request.headers["idempotency-key"];
    if (!context) return reply.code(401).send({ code: "unauthorized", message: "Session requise.", requestId: request.id });
    if (!parsed.success) return reply.code(400).send({ code: "invalid_message", message: "Vérifiez le numéro et le texte du message.", requestId: request.id });
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      return reply.code(400).send({ code: "idempotency_key_required", message: "Une clé d’action valide est requise.", requestId: request.id });
    }
    if (config.OPERATIONS_PAUSED) return reply.code(503).send({ code: "operations_paused", message: config.OPERATIONS_PAUSE_MESSAGE, requestId: request.id });
    if (!config.SMS_ENABLED || !serviceSupabase || !config.TWILIO_ACCOUNT_SID || !config.TWILIO_API_KEY_SID || !config.TWILIO_API_KEY_SECRET) {
      return reply.code(503).send({ code: "sms_disabled", message: "Le service SMS n’est pas configuré dans cet environnement.", requestId: request.id });
    }
    const allowedPrefixes = config.TWILIO_ALLOWED_DESTINATIONS.split(",").map((prefix) => prefix.trim()).filter(Boolean);
    const allowedRecipients = config.SMS_ALLOWED_RECIPIENTS.split(",").map((number) => number.trim()).filter(Boolean);
    if (!allowedPrefixes.some((prefix) => parsed.data.destination.startsWith(prefix)) || !allowedRecipients.includes(parsed.data.destination)) {
      return reply.code(403).send({ code: "destination_not_allowed", message: "Ce destinataire n’est pas autorisé pour les SMS de démonstration.", requestId: request.id });
    }
    const smsAllowed = await consumeUserRateLimit(context.userId, "sms_send", 60, 10);
    if (smsAllowed === null) return reply.code(503).send({ code: "sms_unavailable", message: "Les limites SMS ne sont pas disponibles.", requestId: request.id });
    if (!smsAllowed) return reply.code(429).send({ code: "sms_rate_limited", message: "Trop de messages envoyés. Réessayez dans une minute.", requestId: request.id });
    const { data: prepared, error } = await context.supabase.rpc("prepare_outbound_message", {
      p_org_id: parsed.data.organizationId,
      p_line_id: parsed.data.lineId,
      p_destination: parsed.data.destination,
      p_body: parsed.data.body,
      p_idempotency_key: idempotencyKey,
      p_request_hash: createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex"),
    });
    if (error || !prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
      request.log.warn({ code: error?.code, requestId: request.id, lineId: parsed.data.lineId }, "outbound message rejected");
      if (error?.code === "42501") return reply.code(403).send({ code: "message_forbidden", message: "Cette ligne ou cette destination n’est pas autorisée.", requestId: request.id });
      if (error?.code === "54000") return reply.code(429).send({ code: "message_limit_reached", message: "Le plafond quotidien de messages de démonstration est atteint.", requestId: request.id });
      if (error?.code === "22023") return reply.code(409).send({ code: "idempotency_conflict", message: "Cette clé a déjà été utilisée avec d’autres données.", requestId: request.id });
      return reply.code(503).send({ code: "message_not_prepared", message: "Le message n’a pas pu être préparé.", requestId: request.id });
    }
    const outgoing = prepared as { messageId?: string; conversationId?: string; fromNumber?: string; destination?: string; replayed?: boolean };
    if (!outgoing.messageId || !outgoing.conversationId || !outgoing.fromNumber || !outgoing.destination) {
      return reply.code(503).send({ code: "message_not_prepared", message: "Le message n’a pas pu être préparé.", requestId: request.id });
    }
    if (outgoing.replayed) {
      const { data: existing } = await context.supabase.from("messages").select("id, conversation_id, status, provider_message_sid, created_at")
        .eq("id", outgoing.messageId).maybeSingle();
      request.log.info({ requestId: request.id, organizationId: parsed.data.organizationId, lineId: parsed.data.lineId, conversationId: outgoing.conversationId, messageId: outgoing.messageId, messageSid: existing?.provider_message_sid ?? undefined, status: existing?.status ?? "unknown", replayed: true }, "outbound message intent replayed");
      return reply.code(202).send({ id: outgoing.messageId, conversationId: outgoing.conversationId, status: existing?.status ?? "unknown", submissionConfirmed: Boolean(existing?.provider_message_sid), replayed: true });
    }

    const callback = `${config.API_PUBLIC_URL.replace(/\/$/, "")}/webhooks/twilio/messages/status?messageId=${encodeURIComponent(outgoing.messageId)}`;
    const client = makeSmsProvider(config.TWILIO_API_KEY_SID, config.TWILIO_API_KEY_SECRET, config.TWILIO_ACCOUNT_SID);
    try {
      const sent = await client.messages.create({ from: outgoing.fromNumber, to: outgoing.destination, body: parsed.data.body, statusCallback: callback });
      const status = sent.status === "delivered" ? "delivered"
        : sent.status === "failed" ? "failed"
          : sent.status === "undelivered" ? "undelivered"
            : sent.status === "sent" ? "sent"
              : ["accepted", "queued", "sending", "scheduled"].includes(sent.status) ? "submitting" : "unknown";
      const { data: storedResult, error: storeError } = await serviceSupabase.rpc("update_outbound_message_result", {
        p_message_id: outgoing.messageId,
        p_message_sid: sent.sid,
        p_status: status,
        ...(sent.errorCode == null ? {} : { p_error_code: String(sent.errorCode) }),
      });
      if (storeError) request.log.error({ code: storeError.code, requestId: request.id, messageId: outgoing.messageId }, "sent message result not stored");
      const persistedStatus = storedResult && typeof storedResult === "object" && !Array.isArray(storedResult)
        ? (storedResult as { status?: unknown }).status
        : undefined;
      const responseStatus = storeError
        ? "unknown"
        : typeof persistedStatus === "string" && ["pending", "submitting", "unknown", "sent", "delivered", "undelivered", "failed", "received"].includes(persistedStatus)
          ? persistedStatus
          : status;
      const submittedFields = { requestId: request.id, organizationId: parsed.data.organizationId, lineId: parsed.data.lineId, conversationId: outgoing.conversationId, messageId: outgoing.messageId, messageSid: sent.sid, status: responseStatus, replayed: false };
      if (storeError) request.log.error(submittedFields, "outbound message result uncertain");
      else request.log.info(submittedFields, "outbound message submitted");
      return reply.code(201).send({ id: outgoing.messageId, conversationId: outgoing.conversationId, status: responseStatus, submissionConfirmed: !storeError && Boolean(sent.sid) });
    } catch (providerError) {
      const failure = providerError as { status?: number; code?: number | string };
      const providerCode = safeProviderCode(failure.code);
      const providerStatus = typeof failure.status === "number" && Number.isSafeInteger(failure.status) ? failure.status : undefined;
      const definiteFailure = providerStatus !== undefined && providerStatus >= 400 && providerStatus < 500;
      const status = definiteFailure ? "failed" : "unknown";
      const { error: storeError } = await serviceSupabase.rpc("update_outbound_message_result", {
        p_message_id: outgoing.messageId,
        // The SQL function accepts NULL when Twilio did not return a message SID.
        p_message_sid: null as unknown as string,
        p_status: status,
        ...(providerCode === undefined ? {} : { p_error_code: String(providerCode) }),
      });
      request.log.warn({ providerStatus, providerCode, requestId: request.id, organizationId: parsed.data.organizationId, lineId: parsed.data.lineId, messageId: outgoing.messageId }, "outbound message delivery uncertain");
      if (storeError) request.log.error({ code: storeError.code, requestId: request.id, messageId: outgoing.messageId }, "message outcome not stored");
      if (definiteFailure) return reply.code(422).send({ code: "message_failed", message: "Twilio a refusé ce message.", requestId: request.id, id: outgoing.messageId, status });
      return reply.code(202).send({ id: outgoing.messageId, conversationId: outgoing.conversationId, status: storeError ? "unknown" : status });
    }
  });

  routes.post("/webhooks/twilio/messages/inbound", async (request, reply) => {
    reply.type("text/xml; charset=utf-8");
    const emptyResponse = new twilio.twiml.MessagingResponse().toString();
    if (!validateTwilioWebhook(request)) return reply.code(403).send(emptyResponse);
    const body = request.body as Record<string, string>;
    if (typeof body.AccountSid !== "string" || body.AccountSid !== config.TWILIO_ACCOUNT_SID) return reply.code(403).send(emptyResponse);
    if (!serviceSupabase || !config.SMS_ENABLED) return reply.code(503).send(emptyResponse);
    const { data: created, error } = await serviceSupabase.rpc("create_inbound_message", {
      p_account_sid: body.AccountSid,
      p_message_sid: body.MessageSid ?? "",
      p_from: body.From ?? "",
      p_to: body.To ?? "",
      p_body: body.Body ?? "",
    });
    if (error) {
      request.log.warn({ code: error.code, requestId: request.id }, "inbound message could not be stored");
      return reply.code(503).send(emptyResponse);
    }
    const inboundMessage = created && typeof created === "object" && !Array.isArray(created)
      ? created as { allowed?: boolean; duplicate?: boolean; messageId?: string; conversationId?: string }
      : {};
    request.log.info({ requestId: request.id, messageId: inboundMessage.messageId, conversationId: inboundMessage.conversationId, messageSid: body.MessageSid, allowed: inboundMessage.allowed === true, duplicate: inboundMessage.duplicate === true }, "inbound message processed");
    return reply.send(emptyResponse);
  });

  routes.post("/webhooks/twilio/messages/status", async (request, reply) => {
    if (!validateTwilioWebhook(request)) return reply.code(403).send({ code: "invalid_signature" });
    const body = request.body as Record<string, string>;
    const messageId = uuidSchema.safeParse((request.query as { messageId?: string }).messageId);
    if (typeof body.AccountSid !== "string" || body.AccountSid !== config.TWILIO_ACCOUNT_SID || !messageId.success) return reply.code(403).send({ code: "invalid_callback" });
    if (!serviceSupabase) return reply.code(503).send({ code: "webhook_storage_unavailable" });
    const { data: applied, error } = await serviceSupabase.rpc("apply_message_status", {
      p_account_sid: body.AccountSid,
      p_message_id: messageId.data,
      p_message_sid: body.MessageSid ?? "",
      p_status: body.MessageStatus ?? "",
      ...(body.ErrorCode ? { p_error_code: body.ErrorCode } : {}),
    });
    if (error) {
      request.log.warn({ code: error.code, requestId: request.id, messageId: messageId.data }, "message status callback deferred");
      return reply.code(503).send({ code: "status_not_recorded" });
    }
    const messageOutcome = applied && typeof applied === "object" && !Array.isArray(applied)
      ? applied as { messageId?: string; status?: string; duplicate?: boolean }
      : {};
    request.log.info({ requestId: request.id, messageId: messageOutcome.messageId ?? messageId.data, messageSid: body.MessageSid, providerStatus: body.MessageStatus, status: messageOutcome.status, duplicate: messageOutcome.duplicate === true }, "message status event processed");
    return reply.code(204).send();
  });

  return app;
}
