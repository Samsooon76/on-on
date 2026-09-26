import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json, QueueConfig, VoiceFlow } from "@onoff/contracts";

type Table<Row> = { Row: Row; Insert: Row; Update: Partial<Row>; Relationships: [] };
export type WorkspaceRow = { organization_id: string; workspace_sid: string | null; activities: Record<string, string>; lock_token: string | null; locked_until: string | null; updated_at: string };
export type QueueRow = { id: string; organization_id: string; line_id: string; config: QueueConfig; synced_version: number; queue_sid: string | null; workflow_sid: string | null; version: number; updated_at: string };
export type AgentRow = { organization_id: string; user_id: string; worker_sid: string; contact_number: string | null };
export type FlowRow = { organization_id: string; line_id: string; draft: VoiceFlow; published: VoiceFlow | null; version: number; published_at: string | null };
type CenterDatabase = { public: {
  Tables: Omit<Database["public"]["Tables"], "call_reservations"> & {
    call_reservations: { Row: Database["public"]["Tables"]["call_reservations"]["Row"] & { routing_reservation_sid: string | null }; Insert: Database["public"]["Tables"]["call_reservations"]["Insert"] & { routing_reservation_sid?: string | null }; Update: Database["public"]["Tables"]["call_reservations"]["Update"] & { routing_reservation_sid?: string | null }; Relationships: Database["public"]["Tables"]["call_reservations"]["Relationships"] };
    voice_workspaces: Table<WorkspaceRow>;
    voice_queues: Table<QueueRow>;
    voice_agents: Table<AgentRow>;
    voice_flows: Table<FlowRow>;
    voice_voicemails: Table<{ id: string; organization_id: string; call_id: string; recording_sid: string; duration: number; created_at: string }>;
  };
  Views: Database["public"]["Views"];
  Functions: Database["public"]["Functions"] & {
    voice_center_lock: { Args: { p_org_id: string; p_actor_id: string; p_token: string; p_release?: boolean }; Returns: boolean };
    voice_flow_save: { Args: { p_org_id: string; p_actor_id: string; p_line_id: string; p_config: VoiceFlow; p_version: number; p_publish: boolean }; Returns: number };
    voice_reserve_agent: { Args: { p_org_id: string; p_user_id: string; p_call_id: string; p_seconds: number; p_reservation_sid: string }; Returns: string | null };
  };
  Enums: Database["public"]["Enums"];
  CompositeTypes: Database["public"]["CompositeTypes"];
} };
export type CenterStore = SupabaseClient<CenterDatabase>;
export function centerStore(client: SupabaseClient<Database>): CenterStore { return client as unknown as CenterStore; }
export function checked<T>(result: { data: T[] | null; error: { code?: string } | null }): T[];
export function checked<T>(result: { data: T; error: { code?: string } | null }): T;
export function checked<T>(result: { data: T; error: { code?: string } | null }): T {
  if (result.error) {
    const statusCode = result.error.code === "40001" ? 409 : result.error.code === "23503" || result.error.code === "22023" ? 400 : result.error.code === "42501" ? 403 : result.error.code === "P0002" ? 404 : 503;
    throw Object.assign(new Error(statusCode === 409 ? "La configuration a changé. Actualisez avant de réessayer." : statusCode === 400 ? "Vérifiez les files et leurs accès à la ligne." : "Le centre d’appels est momentanément indisponible."), { statusCode });
  }
  return result.data;
}
export function problem(message: string, statusCode = 400): never { throw Object.assign(new Error(message), { statusCode }); }
