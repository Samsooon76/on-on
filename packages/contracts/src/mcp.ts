import { z } from "zod";

export const mcpPermissionSchema = z.enum(["contacts:read", "messages:read", "calls:read", "contacts:write", "messages:send", "calls:prepare"]);
export type McpPermission = z.infer<typeof mcpPermissionSchema>;
export const mcpPermissionLabels: Record<McpPermission, string> = {
  "contacts:read": "Consulter le carnet de contacts de l’organisation",
  "messages:read": "Lire les conversations et les SMS des lignes choisies",
  "calls:read": "Consulter l’historique des appels des lignes choisies",
  "contacts:write": "Créer et modifier des contacts",
  "messages:send": "Préparer des SMS à valider dans Onoff",
  "calls:prepare": "Préparer un appel dans le composeur Onoff",
};
export const mcpGrantCreateSchema = z.object({
  authorizationId: z.string().min(1).max(200),
  organizationId: z.uuid(),
  lineIds: z.array(z.uuid()).max(100).refine(ids => new Set(ids).size === ids.length),
  permissions: z.array(mcpPermissionSchema).min(1).max(6).refine(ids => new Set(ids).size === ids.length),
}).strict().refine(value => !value.permissions.includes("contacts:write") || value.permissions.includes("contacts:read"), { message: "La modification des contacts nécessite leur consultation." });
export type McpGrant = {
  id: string; user_id: string; client_id: string; client_name: string; organization_id: string;
  line_ids: string[]; permissions: McpPermission[]; created_at: string; revoked_at: string | null;
  last_used_at: string | null;
};
export type McpSmsDraft = {
  id: string; grant_id: string; user_id: string; organization_id: string; line_id: string;
  destination: string; body: string; request_key: string; state: "pending" | "approved" | "rejected" | "submitted";
  created_at: string; expires_at: string; approved_at: string | null; message_id: string | null;
};
export type McpSmsAction = McpSmsDraft & {
  clientName: string; lineNumber: string; messageStatus: string | null; submissionConfirmed: boolean;
};
export const mcpSmsDraftSchema = z.object({
  lineId: z.uuid(), destination: z.string().regex(/^\+[1-9]\d{7,14}$/),
  body: z.string().trim().min(1).max(1600), requestKey: z.uuid(),
}).strict();
