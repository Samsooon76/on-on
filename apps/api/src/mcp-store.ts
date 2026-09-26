import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json, McpGrant, McpSmsDraft } from "@onoff/contracts";

export type GrantRow = McpGrant & { resource_url: string };
type Table<Row> = { Row: Row; Insert: Partial<Row>; Update: Partial<Row>; Relationships: [] };
type McpDatabase = { public: {
  Tables: Database["public"]["Tables"] & {
    mcp_grants: Table<GrantRow>;
    mcp_sms_drafts: Table<McpSmsDraft>;
    mcp_audit_events: Table<{ grant_id: string; tool: string; outcome: string; request_id: string }>;
  };
  Views: Database["public"]["Views"];
  Functions: Database["public"]["Functions"] & {
    mcp_create_grant: { Args: { p_user: string; p_client: string; p_name: string; p_org: string; p_lines: string[]; p_permissions: string[]; p_resource: string }; Returns: GrantRow };
    mcp_write_contact: { Args: { p_user: string; p_grant: string; p_key: string; p_payload: Json }; Returns: string };
    mcp_create_sms_draft: { Args: { p_user: string; p_grant: string; p_key: string; p_line: string; p_destination: string; p_body: string }; Returns: McpSmsDraft };
    mcp_decide_sms: { Args: { p_user: string; p_draft: string; p_approve: boolean }; Returns: McpSmsDraft };
    mcp_prepare_sms: { Args: { p_user: string; p_grant: string; p_draft: string; p_hash: string }; Returns: Json };
  };
  Enums: Database["public"]["Enums"];
  CompositeTypes: Database["public"]["CompositeTypes"];
} };
export type McpStore = SupabaseClient<McpDatabase>;
export function mcpStore(client: SupabaseClient<Database>): McpStore { return client as unknown as McpStore; }
export function mcpError(message: string, statusCode = 400, code = "mcp_error"): never {
  throw Object.assign(new Error(message), { statusCode, code });
}
export function checked<T>(result: { data: T; error: { code?: string } | null }): T {
  if (result.error) {
    const code = result.error.code;
    const status = code === "42501" ? 403 : code === "P0002" ? 404 : code === "40001" || code === "22023" || code === "55000" ? 409 : code === "54000" ? 429 : 503;
    mcpError(status === 403 ? "Accès refusé ou validation du SMS requise." : status === 404 ? "Élément introuvable." : status === 409 ? "Action expirée, modifiée ou déjà utilisée. Vérifiez son état avant de réessayer." : status === 429 ? "Limite d’actions atteinte. Réessayez plus tard." : "L’intégration est momentanément indisponible.", status);
  }
  return result.data;
}
