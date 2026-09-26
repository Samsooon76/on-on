import { z } from "zod";

export const webhookEventLabels = {
  "sms.received": "SMS reçu",
  "sms.sent": "SMS envoyé au réseau",
  "sms.delivered": "SMS livré",
  "sms.failed": "SMS en échec",
  "call.received": "Appel entrant",
  "call.started": "Appel sortant démarré",
  "call.connected": "Appel connecté",
  "call.ended": "Appel terminé",
  "call.missed": "Appel entrant manqué",
  "voicemail.received": "Message vocal reçu",
  "user.status_changed": "Statut ou rôle d’un utilisateur modifié",
  "user.reachability_changed":
    "Disponibilité téléphonique de l’application modifiée",
} as const;
export const webhookEventSchema = z.enum(
  Object.keys(webhookEventLabels) as [
    keyof typeof webhookEventLabels,
    ...(keyof typeof webhookEventLabels)[],
  ],
);
export type WebhookEvent = z.infer<typeof webhookEventSchema>;
export const webhookCreateSchema = z
  .object({
    description: z.string().trim().min(1).max(120),
    url: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.hash &&
          (!url.port || url.port === "443")
        );
      }, "Utilisez une URL HTTPS publique sur le port 443, sans identifiants ni fragment."),
    events: z
      .array(webhookEventSchema)
      .min(1)
      .max(12)
      .refine(
        (events) => new Set(events).size === events.length,
        "Événements dupliqués.",
      ),
  })
  .strict();
export const webhookUpdateSchema = z.object({ enabled: z.boolean() }).strict();
export const webhookEndpointSchema = webhookCreateSchema.extend({
  id: z.string().uuid(),
  enabled: z.boolean(),
  createdAt: z.string(),
});
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;
export const webhookDeliverySchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  eventType: z.string(),
  status: z.enum(["pending", "sending", "delivered", "failed", "canceled"]),
  attempts: z.number().int(),
  httpStatus: z.number().int().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  nextAttemptAt: z.string(),
  deliveredAt: z.string().nullable(),
});
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

const nullableTime = z.string().nullable();
const smsData = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  lineId: z.string().uuid(),
  remoteNumber: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  body: z.string(),
  status: z.enum(["received", "sent", "delivered", "failed", "undelivered"]),
  createdAt: z.string(),
  sentAt: nullableTime,
  deliveredAt: nullableTime,
  errorCode: z.string().nullable(),
});
const callData = z.object({
  id: z.string().uuid(),
  lineId: z.string().uuid(),
  direction: z.enum(["inbound", "outbound"]),
  remoteNumber: z.string(),
  status: z.enum([
    "initiated",
    "ringing",
    "answered",
    "completed",
    "missed",
    "failed",
    "canceled",
  ]),
  startedAt: nullableTime,
  answeredAt: nullableTime,
  endedAt: nullableTime,
  durationSeconds: z.number().int().nullable(),
});
const envelope = z.object({
  id: z.string().uuid(),
  apiVersion: z.literal("v1"),
  createdAt: z.string(),
  organizationId: z.string().uuid(),
});
export const webhookPayloadSchema = z.union([
  envelope.extend({
    type: z.enum(["sms.received", "sms.sent", "sms.delivered", "sms.failed"]),
    data: smsData,
  }),
  envelope.extend({
    type: z.enum([
      "call.received",
      "call.started",
      "call.connected",
      "call.ended",
      "call.missed",
    ]),
    data: callData,
  }),
  envelope.extend({
    type: z.literal("voicemail.received"),
    data: z.object({
      id: z.string().uuid(),
      callId: z.string().uuid(),
      lineId: z.string().uuid(),
      durationSeconds: z.number().int(),
      createdAt: z.string(),
    }),
  }),
  envelope.extend({
    type: z.literal("user.status_changed"),
    data: z.object({
      userId: z.string().uuid(),
      status: z.enum(["active", "suspended", "revoked"]),
      previousStatus: z.string().nullable(),
      role: z.enum(["admin", "member"]),
      previousRole: z.string().nullable(),
    }),
  }),
  envelope.extend({
    type: z.literal("user.reachability_changed"),
    data: z.object({
      userId: z.string().uuid(),
      status: z.enum(["available", "busy", "offline"]),
      previousStatus: z.enum(["available", "busy", "offline"]),
    }),
  }),
  envelope.extend({
    type: z.literal("webhook.test"),
    data: z.object({ message: z.string() }),
  }),
]);
