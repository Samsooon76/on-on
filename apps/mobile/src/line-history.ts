import type { ApiPage, CallRecord, Conversation } from "@onoff/api-client";

type HistoryPermissions = { can_voice: boolean; can_sms: boolean };
type ApiRequest = <T>(path: string) => Promise<T>;

export async function loadLineHistory(api: ApiRequest, lineId: string, permissions: HistoryPermissions) {
  // A voice-only line has no SMS access: requesting conversations returns 404.
  const [calls, conversations] = await Promise.all([
    permissions.can_voice
      ? api<ApiPage<CallRecord>>(`/v1/lines/${lineId}/calls?limit=50`)
      : { items: [], nextCursor: null } satisfies ApiPage<CallRecord>,
    permissions.can_sms
      ? api<ApiPage<Conversation>>(`/v1/lines/${lineId}/conversations?limit=50`)
      : { items: [], nextCursor: null } satisfies ApiPage<Conversation>,
  ]);
  return { calls, conversations };
}
