import { z } from "zod";

export const tagKindSchema = z.literal("call");
export const tagInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#246653"),
  kind: tagKindSchema,
  aiEnabled: z.boolean().default(false),
  prompt: z.string().trim().max(2000).default(""),
}).strict().refine(value => !value.aiEnabled || value.prompt.length >= 10, { message: "Décrivez le critère du tag en au moins 10 caractères.", path: ["prompt"] });
export const tagSchema = z.object({
  id: z.string().uuid(), organizationId: z.string().uuid(), name: z.string(), color: z.string(),
  kind: tagKindSchema, aiEnabled: z.boolean(), prompt: z.string(), updatedAt: z.string(),
});
export const tagSettingsInputSchema = z.object({
  callsEnabled: z.boolean(),
  confidenceThreshold: z.number().min(0.5).max(0.99),
}).strict();
export const tagSettingsSchema = tagSettingsInputSchema.extend({ updatedAt: z.string().nullable() });
export const tagCatalogSchema = z.object({
  items: z.array(tagSchema), settings: tagSettingsSchema, providerAvailable: z.boolean(), canManage: z.boolean(),
});
export const tagAssignmentSchema = z.object({
  tag: tagSchema, source: z.enum(["manual", "ai"]), confidence: z.number().nullable(),
});
export const tagSubjectSchema = z.object({
  organizationId: z.string().uuid(), assignments: z.array(tagAssignmentSchema),
  status: z.enum(["idle", "pending", "processing", "completed", "skipped", "error"]),
  message: z.string().nullable(),
});
export const tagManualSchema = z.object({ assigned: z.boolean() }).strict();
export type TagKind = z.infer<typeof tagKindSchema>;
export type TagInput = z.infer<typeof tagInputSchema>;
export type Tag = z.infer<typeof tagSchema>;
export type TagSettingsInput = z.infer<typeof tagSettingsInputSchema>;
export type TagCatalog = z.infer<typeof tagCatalogSchema>;
export type TagSubject = z.infer<typeof tagSubjectSchema>;
