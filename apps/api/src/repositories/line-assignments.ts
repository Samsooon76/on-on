import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@onoff/contracts";

export type LineAssignmentCommand = {
  organizationId: string;
  lineId: string;
  userId: string;
  actorId: string;
  canVoice: boolean;
  canSms: boolean;
  revoke: boolean;
};

export async function persistLineAssignment(
  serviceSupabase: SupabaseClient<Database>,
  command: LineAssignmentCommand,
): Promise<{ id: string | null; errorCode: string | null }> {
  const { data, error } = await serviceSupabase.rpc("set_line_assignment", {
    p_org_id: command.organizationId,
    p_line_id: command.lineId,
    p_user_id: command.userId,
    p_actor_id: command.actorId,
    p_can_voice: command.canVoice,
    p_can_sms: command.canSms,
    p_revoke: command.revoke,
  });
  return { id: data, errorCode: error?.code ?? null };
}
