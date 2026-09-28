import type { ApiPage, CallRecord, Conversation } from "@onoff/api-client";

type HistoryPermissions = { can_voice: boolean; can_sms: boolean };
type ApiRequest = <T>(path: string) => Promise<T>;
// Each listener gets its page as soon as it resolves, so the first screen never waits for the slower list.
// A list the line has no permission for is reported as an empty page, without any request.
type HistoryListeners = { onConversations?(page: ApiPage<Conversation>): void; onCalls?(page: ApiPage<CallRecord>): void };

const emptyPage = <T>(): ApiPage<T> => ({ items: [], nextCursor: null });

export async function loadLineHistory(api: ApiRequest, lineId: string, permissions: HistoryPermissions, listeners: HistoryListeners = {}) {
  // A voice-only line has no SMS access: requesting conversations returns 404.
  const [calls, conversations] = await Promise.all([
    (permissions.can_voice ? api<ApiPage<CallRecord>>(`/v1/lines/${lineId}/calls?limit=50`) : Promise.resolve(emptyPage<CallRecord>()))
      .then((page) => { listeners.onCalls?.(page); return page; }),
    (permissions.can_sms ? api<ApiPage<Conversation>>(`/v1/lines/${lineId}/conversations?limit=50`) : Promise.resolve(emptyPage<Conversation>()))
      .then((page) => { listeners.onConversations?.(page); return page; }),
  ]);
  return { calls, conversations };
}
