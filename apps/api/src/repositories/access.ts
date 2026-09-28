import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@onoff/contracts";

export type ScopeLookup<T> = { data: T | null; unavailable: boolean };

export async function isActiveOrganizationAdmin(
  supabase: SupabaseClient<Database>,
  userId: string,
  organizationId: string,
): Promise<ScopeLookup<boolean>> {
  const { data, error } = await supabase
    .from("memberships")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error) return { data: null, unavailable: true };
  return { data: data?.role === "admin", unavailable: false };
}
