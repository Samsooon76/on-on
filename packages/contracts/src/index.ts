import { z } from "zod";
export * from "./admin.js";

export type { Database, Json } from "./database.types.js";

export const uuidSchema = z.string().uuid();
export const e164Schema = z.string().regex(/^\+[1-9]\d{7,14}$/, "Numéro E.164 invalide");

/** Normalize formatted international numbers and French national numbers to E.164. */
export function normalizePhoneNumber(input: string): string | null {
  const value = input.trim();
  if (!value || value.length > 64 || !/^[+0-9\s().-]+$/.test(value)) return null;

  const compact = value.replace(/[\s().-]/g, "");
  if ((compact.match(/\+/g)?.length ?? 0) > 1 || (compact.includes("+") && !compact.startsWith("+"))) return null;

  let candidate: string;
  if (compact.startsWith("+")) candidate = compact;
  else if (compact.startsWith("00")) candidate = `+${compact.slice(2)}`;
  else if (/^0[1-9]\d{8}$/.test(compact)) candidate = `+33${compact.slice(1)}`;
  else return null;

  if (candidate.startsWith("+330")) candidate = `+33${candidate.slice(4)}`;

  return e164Schema.safeParse(candidate).success ? candidate : null;
}

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

export const lineAssignmentUpdateSchema = z.object({
  canVoice: z.boolean(),
  canSms: z.boolean(),
}).refine(({ canVoice, canSms }) => canVoice || canSms, {
  message: "Une affectation doit autoriser la voix ou les SMS.",
});

export type Organization = z.infer<typeof organizationSchema>;
export type Line = z.infer<typeof lineSchema>;
export type ContactCreate = z.infer<typeof contactCreateSchema>;
export type ContactUpdate = z.infer<typeof contactUpdateSchema>;
export type DeviceCreate = z.infer<typeof deviceCreateSchema>;
export type LineAssignmentUpdate = z.infer<typeof lineAssignmentUpdateSchema>;

export const numberCountrySchema = z.enum(["FR", "BE", "GB", "US"]);
export const numberPurchaseSchema = z.object({ quoteId: uuidSchema }).strict();
export const numberOfferSchema = z.object({
  quoteId: uuidSchema,
  phoneNumber: e164Schema,
  monthlyPrice: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  smsEnabled: z.boolean(),
  expiresAt: z.string(),
});
export const numberOrderSchema = z.object({
  id: uuidSchema,
  requestKey: uuidSchema,
  status: z.enum(["pending", "completed", "failed"]),
  phoneNumber: e164Schema,
  lineId: uuidSchema.nullable(),
  message: z.string(),
});
export type NumberOffer = z.infer<typeof numberOfferSchema>;
export type NumberOrder = z.infer<typeof numberOrderSchema>;

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

export * from "./call-center.js";
