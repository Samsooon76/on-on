import { z } from "zod";

const id = z.string().uuid();
export const memberRoleSchema = z.enum(["admin", "member"]);
export const memberStatusSchema = z.enum(["active", "suspended", "revoked"]);
export const adminMemberCreateSchema = z.object({
  email: z.email().max(254).transform((email) => email.toLowerCase()),
  displayName: z.string().trim().min(1).max(120),
  role: memberRoleSchema,
  password: z.string().min(12).max(128),
}).strict();
export const adminMemberUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  role: memberRoleSchema,
  status: memberStatusSchema,
  version: z.string().datetime({ offset: true }),
}).strict();
export const ivrConfigSchema = z.object({
  enabled: z.boolean(),
  greeting: z.string().trim().min(1).max(1000),
  language: z.enum(["fr-FR", "en-GB", "en-US"]),
  timeout: z.number().int().min(3).max(15),
  maxAttempts: z.number().int().min(1).max(3),
  fallback: z.enum(["all", "hangup"]),
  options: z.array(z.object({
    digit: z.string().regex(/^[0-9]$/),
    label: z.string().trim().min(1).max(80),
    userId: id.nullable(),
  }).strict()).max(10),
}).strict().superRefine((value, context) => {
  if (value.enabled && value.options.length === 0) context.addIssue({ code: "custom", message: "Ajoutez au moins une touche au menu.", path: ["options"] });
  if (new Set(value.options.map((option) => option.digit)).size !== value.options.length) context.addIssue({ code: "custom", message: "Chaque touche doit être unique.", path: ["options"] });
});
export const adminIvrUpdateSchema = z.object({ config: ivrConfigSchema, version: z.string().datetime({ offset: true }) }).strict();
export type IvrConfig = z.infer<typeof ivrConfigSchema>;
export const defaultIvrConfig: IvrConfig = { enabled: false, greeting: "Bienvenue. Merci de choisir votre interlocuteur.", language: "fr-FR", timeout: 5, maxAttempts: 2, fallback: "all", options: [] };
export type AdminMember = { user_id: string; display_name: string; email: string; role: "admin" | "member"; status: "active" | "suspended" | "revoked"; updated_at: string };
export type AdminLine = { id: string; phone_number: string; status: string; voice_enabled: boolean; sms_enabled: boolean; ivr_config: IvrConfig; updated_at: string };
export type AdminAssignment = { line_id: string; user_id: string; can_voice: boolean; can_sms: boolean; status: string };
export type AdminAuditEvent = { id: string; actor_user_id: string | null; action: string; target_type: string; target_id: string | null; created_at: string };
export type AdminSnapshot = { members: AdminMember[]; lines: AdminLine[]; assignments: AdminAssignment[]; audit: AdminAuditEvent[] };
