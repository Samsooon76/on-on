import { z } from "zod";

export type { Database, Json } from "./database.types.js";

export const uuidSchema = z.string().uuid();
export const e164Schema = z.string().regex(/^\+[1-9]\d{7,14}$/, "Numéro E.164 invalide");

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().optional(),
});

export const errorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
});

export const organizationSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1),
  role: z.enum(["admin", "member"]),
});

export const lineSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  phoneNumber: e164Schema,
  canVoice: z.boolean(),
  canSms: z.boolean(),
});

export const contactCreateSchema = z.object({
  organizationId: uuidSchema,
  displayName: z.string().trim().min(1).max(120),
  email: z.email().optional().nullable(),
  phones: z.array(z.object({
    phoneNumber: e164Schema,
    label: z.string().trim().min(1).max(40).default("Mobile"),
  })).max(10).default([]),
});

export const contactUpdateSchema = contactCreateSchema.omit({ organizationId: true }).extend({
  version: z.number().int().positive(),
});

export const deviceCreateSchema = z.object({
  organizationId: uuidSchema,
  platform: z.enum(["web", "ios", "android", "windows", "macos"]),
  label: z.string().trim().min(1).max(80),
});

export type Organization = z.infer<typeof organizationSchema>;
export type Line = z.infer<typeof lineSchema>;
export type ContactCreate = z.infer<typeof contactCreateSchema>;
export type ContactUpdate = z.infer<typeof contactUpdateSchema>;
export type DeviceCreate = z.infer<typeof deviceCreateSchema>;

export const voiceTargetSchema = z.object({
  organizationId: uuidSchema,
  lineId: uuidSchema,
  deviceId: uuidSchema,
});

export const callIntentCreateSchema = voiceTargetSchema.extend({
  destination: e164Schema,
});

export const messageCreateSchema = z.object({
  organizationId: uuidSchema,
  lineId: uuidSchema,
  destination: e164Schema,
  body: z.string().trim().min(1).max(1600),
});

export type VoiceTarget = z.infer<typeof voiceTargetSchema>;
export type CallIntentCreate = z.infer<typeof callIntentCreateSchema>;
export type MessageCreate = z.infer<typeof messageCreateSchema>;
