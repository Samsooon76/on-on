import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@onoff/contracts";

export type LinePermission = "can_voice" | "can_sms";
export type AssignedLineScope = { organizationId: string; lineId: string };
export type ScopeLookup<T> = { data: T | null; unavailable: boolean };

export async function getActiveOrganizationIds(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<ScopeLookup<string[]>> {
  const { data, error } = await supabase
    .from("memberships")
    .select("organization_id")
    .eq("user_id", userId)
    .eq("status", "active");
  if (error) return { data: null, unavailable: true };
  return { data: [...new Set((data ?? []).map(({ organization_id }) => organization_id))], unavailable: false };
}

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

export async function findAssignedLine(
  supabase: SupabaseClient<Database>,
  userId: string,
  lineId: string,
  permission: LinePermission,
): Promise<ScopeLookup<AssignedLineScope>> {
  const organizations = await getActiveOrganizationIds(supabase, userId);
  if (organizations.unavailable) return { data: null, unavailable: true };
  if (!organizations.data?.length) return { data: null, unavailable: false };

  const { data, error } = await supabase
    .from("line_assignments")
    .select("organization_id, line_id")
    .in("organization_id", organizations.data)
    .eq("line_id", lineId)
    .eq("user_id", userId)
    .eq("status", "active")
    .eq(permission, true)
    .maybeSingle();
  if (error) return { data: null, unavailable: true };
  if (!data) return { data: null, unavailable: false };
  return { data: { organizationId: data.organization_id, lineId: data.line_id }, unavailable: false };
}
