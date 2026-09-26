import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@onoff/contracts";

export type EndpointRow = {
  id: string;
  organization_id: string;
  created_by: string;
  description: string;
  url: string;
  events: string[];
  enabled: boolean;
  created_at: string;
  deleted_at: string | null;
  secret_ciphertext: string;
};
export type DeliveryRow = {
  id: string;
  organization_id: string;
  endpoint_id: string;
  event_id: string;
  status: "pending" | "sending" | "delivered" | "failed" | "canceled";
  attempts: number;
  http_status: number | null;
  last_error: string | null;
  created_at: string;
  next_attempt_at: string;
  delivered_at: string | null;
};
export type WebhookJob = {
  id: string;
  leaseToken: string;
  attempt: number;
  url: string;
  secretCiphertext: string;
  payload: { id: string } & Record<string, Json | undefined>;
};
type Table<Row> = {
  Row: Row;
  Insert: Partial<Row>;
  Update: Partial<Row>;
  Relationships: [];
};
type WebhookDatabase = {
  public: {
    Tables: Database["public"]["Tables"] & {
      webhook_endpoints: Table<EndpointRow>;
      webhook_events: Table<{
        id: string;
        organization_id: string;
        event_type: string;
        payload: Json;
        created_at: string;
      }>;
      webhook_deliveries: Table<DeliveryRow>;
    };
    Views: Database["public"]["Views"];
    Functions: Database["public"]["Functions"] & {
      manage_customer_webhook: {
        Args: {
          p_org: string;
          p_actor: string;
          p_action: string;
          p_id: string;
          p_input?: Json;
        };
        Returns: Json;
      };
      claim_customer_webhooks: {
        Args: { p_limit: number };
        Returns: WebhookJob[];
      };
      finish_customer_webhook: {
        Args: {
          p_id: string;
          p_lease: string;
          p_http_status: number | null;
          p_error: string | null;
        };
        Returns: boolean;
      };
      refresh_webhook_reachability: {
        Args: Record<string, never>;
        Returns: undefined;
      };
      prune_customer_webhooks: {
        Args: Record<string, never>;
        Returns: undefined;
      };
    };
    Enums: Database["public"]["Enums"];
    CompositeTypes: Database["public"]["CompositeTypes"];
  };
};
export type WebhookStore = SupabaseClient<WebhookDatabase>;
export const webhookStore = (client: SupabaseClient<Database>) =>
  client as unknown as WebhookStore;
export function webhookResult<T>(result: {
  data: T;
  error: { code?: string } | null;
}): T {
  if (result.error) {
    const statusCode =
      (
        { "42501": 403, P0002: 404, "22023": 409, "54000": 429 } as Record<
          string,
          number
        >
      )[result.error.code ?? ""] ?? 503;
    throw Object.assign(
      new Error(
        statusCode === 403
          ? "Accès administrateur requis."
          : statusCode === 404
            ? "Webhook introuvable."
            : statusCode === 409
              ? "Vérifiez le statut du webhook et de la livraison."
              : statusCode === 429
                ? "Limite atteinte : 10 webhooks maximum, un test ou une relance par minute."
                : "Le service de webhooks est indisponible.",
      ),
      { statusCode },
    );
  }
  return result.data;
}
