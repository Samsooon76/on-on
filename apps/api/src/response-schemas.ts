import {
  callIntentCreateSchema,
  contactCreateSchema,
  contactUpdateSchema,
  deviceCreateSchema,
  e164Schema,
  errorResponseSchema,
  messageCreateSchema,
  uuidSchema,
  voiceTargetSchema,
} from "@onoff/contracts";
import { z } from "zod";

const timestampSchema = z.string();
const apiErrorSchema = errorResponseSchema;

const contactPhoneResponseSchema = z.object({
  id: uuidSchema,
  phone_number: e164Schema,
  label: z.string(),
});

const contactResponseSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  display_name: z.string(),
  email: z.email().nullable(),
  version: z.number().int(),
  created_at: timestampSchema,
  contact_phones: z.array(contactPhoneResponseSchema),
});

const deviceResponseSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  platform: z.enum(["web", "ios", "android", "windows", "macos"]),
  label: z.string(),
  status: z.enum(["active", "revoked"]),
  last_active_at: timestampSchema.nullable(),
  created_at: timestampSchema,
});

const callResponseSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  line_id: uuidSchema,
  direction: z.enum(["inbound", "outbound"]),
  remote_number: e164Schema,
  status: z.string(),
  started_at: timestampSchema.nullable(),
  answered_at: timestampSchema.nullable(),
  ended_at: timestampSchema.nullable(),
  duration_seconds: z.number().int().nullable(),
  created_at: timestampSchema,
  remoteContactName: z.string().nullable(),
});

const messageStatusSchema = z.enum([
  "pending", "submitting", "unknown", "sent", "delivered", "undelivered", "failed", "received",
]);

const latestMessageResponseSchema = z.object({
  id: uuidSchema,
  conversation_id: uuidSchema,
  body: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  status: messageStatusSchema,
  created_at: timestampSchema,
});

const messageResponseSchema = z.object({
  id: uuidSchema,
  conversation_id: uuidSchema,
  direction: z.enum(["inbound", "outbound"]),
  body: z.string(),
  status: messageStatusSchema,
  provider_error_code: z.string().nullable(),
  created_at: timestampSchema,
  sent_at: timestampSchema.nullable(),
  delivered_at: timestampSchema.nullable(),
});

const contactListResponseSchema = z.object({
  items: z.array(contactResponseSchema),
  nextCursor: z.string().nullable(),
});

const conversationResponseSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  line_id: uuidSchema,
  remote_number: e164Schema,
});

const pendingMessageResponseSchema = z.object({
  message_id: uuidSchema,
  organization_id: uuidSchema,
  conversation_id: uuidSchema,
  line_id: uuidSchema,
  destination: e164Schema,
  body: z.string(),
  idempotency_key: z.string(),
  status: z.enum(["submitting", "unknown"]),
  created_at: timestampSchema,
});

const outboundMessageResultSchema = z.object({
  id: uuidSchema,
  conversationId: uuidSchema,
  status: messageStatusSchema,
  submissionConfirmed: z.boolean().optional(),
  replayed: z.boolean().optional(),
});

const listErrorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  410: apiErrorSchema,
  429: apiErrorSchema,
  500: apiErrorSchema,
  503: apiErrorSchema,
};

export const requestBodySchemas = new Map<string, z.ZodType>([
  ["POST /v1/diagnostics/voice", z.object({
    event: z.enum(["voice_registration_failed", "history_refresh_succeeded", "history_refresh_failed"]),
    platform: z.enum(["web", "ios", "android"]),
    appVersion: z.string().max(32).regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
    durationMs: z.number().int().min(0).max(300_000).optional(),
  })],
  ["POST /v1/organizations/:orgId/contacts", contactCreateSchema.omit({ organizationId: true })],
  ["PATCH /v1/contacts/:id", contactUpdateSchema],
  ["POST /v1/devices", deviceCreateSchema],
  ["PUT /v1/devices/:id/voice-state", z.object({ registered: z.boolean() })],
  ["POST /v1/voice/token", voiceTargetSchema],
  ["POST /v1/call-intents", callIntentCreateSchema],
  ["PUT /v1/conversations/:id/read", z.object({ lastReadMessageId: uuidSchema.nullable().optional() })],
  ["POST /v1/messages", messageCreateSchema],
]);

export const successResponseSchemas = new Map<string, Record<number, z.ZodType>>([
  ["GET /health/live", { 200: z.object({ status: z.literal("ok"), version: z.string().optional() }) }],
  ["GET /health/ready", {
    200: z.object({ status: z.literal("ready"), version: z.string().optional(), dependencies: z.object({ auth: z.boolean(), database: z.boolean() }) }),
    503: z.object({ status: z.literal("unavailable"), version: z.string().optional(), dependencies: z.object({ auth: z.boolean(), database: z.boolean() }) }),
  }],
  ["POST /v1/diagnostics/voice", { 202: z.object({ accepted: z.boolean() }) }],
  ["GET /v1/me", {
    200: z.object({
      userId: uuidSchema,
      organizations: z.array(z.object({
        organization_id: uuidSchema,
        role: z.enum(["admin", "member"]),
        status: z.literal("active"),
        organizations: z.object({ id: uuidSchema, name: z.string() }),
      })),
    }),
  }],
  ["GET /v1/organizations", {
    200: z.object({ items: z.array(z.object({
      organization_id: uuidSchema,
      role: z.enum(["admin", "member"]),
      organizations: z.object({ id: uuidSchema, name: z.string() }),
    })) }),
  }],
  ["GET /v1/organizations/:orgId/contacts", { 200: contactListResponseSchema }],
  ["POST /v1/organizations/:orgId/contacts", { 201: z.union([contactResponseSchema, z.object({ id: uuidSchema })]) }],
  ["GET /v1/contacts/:id", { 200: contactResponseSchema }],
  ["PATCH /v1/contacts/:id", { 200: z.union([contactResponseSchema, z.object({ id: uuidSchema })]) }],
  ["GET /v1/devices", { 200: z.object({ items: z.array(deviceResponseSchema) }) }],
  ["POST /v1/devices", { 201: deviceResponseSchema }],
  ["PUT /v1/devices/:id/voice-state", { 200: z.object({ id: uuidSchema, registered: z.boolean() }) }],
  ["POST /v1/voice/token", {
    200: z.object({ token: z.string().min(1), identity: z.string().min(1), expiresAt: timestampSchema, incomingEnabled: z.boolean() }),
  }],
  ["POST /v1/call-intents", { 201: z.object({ id: uuidSchema, status: z.literal("issued") }) }],
  ["POST /v1/call-intents/:id/cancel", { 200: z.object({ id: uuidSchema, status: z.literal("canceled") }) }],
  ["POST /v1/devices/:id/revoke", { 200: z.object({ id: uuidSchema, status: z.literal("revoked") }) }],
  ["GET /v1/organizations/:orgId/lines", {
    200: z.object({ items: z.array(z.object({
      can_voice: z.boolean(),
      can_sms: z.boolean(),
      lines: z.union([
        z.object({ id: uuidSchema, organization_id: uuidSchema, phone_number: e164Schema, voice_enabled: z.boolean(), sms_enabled: z.boolean() }),
        z.array(z.object({ id: uuidSchema, organization_id: uuidSchema, phone_number: e164Schema, voice_enabled: z.boolean(), sms_enabled: z.boolean() })),
      ]),
    })) }),
  }],
  ["GET /v1/lines/:lineId/calls", { 200: z.object({ items: z.array(callResponseSchema), nextCursor: z.string().nullable() }) }],
  ["GET /v1/lines/:lineId/conversations", {
    200: z.object({ items: z.array(z.object({
      id: uuidSchema,
      lineId: uuidSchema,
      remoteNumber: e164Schema,
      remoteContactName: z.string().nullable(),
      lastMessageAt: timestampSchema,
      lastMessage: latestMessageResponseSchema.nullable(),
      unread: z.boolean(),
    })), nextCursor: z.string().nullable() }),
  }],
  ["GET /v1/conversations/:id/messages", {
    200: z.object({ conversation: conversationResponseSchema, items: z.array(messageResponseSchema), nextCursor: z.string().nullable() }),
  }],
  ["GET /v1/messages/pending", { 200: z.object({ items: z.array(pendingMessageResponseSchema) }) }],
  ["POST /v1/messages", {
    201: outboundMessageResultSchema,
    202: outboundMessageResultSchema,
    422: z.object({ code: z.string(), message: z.string(), requestId: uuidSchema, id: uuidSchema, status: z.literal("failed") }),
  }],
]);

export function responsesForRoute(method: string, url: string): Record<string | number, z.ZodType> | null {
  const success = successResponseSchemas.get(`${method} ${url}`);
  if (!url.startsWith("/v1/")) return success ? { ...success } : null;
  return { ...listErrorResponses, ...(success ?? {}) };
}
