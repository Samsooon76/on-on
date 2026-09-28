import { type ApiPage, type MessageRecord } from "@onoff/api-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { mergeRecords } from "./conversation-model.ts";

type History = { key: string; messages: MessageRecord[]; cursor: string | null; state: "loading" | "ready" | "error"; loadingOlder: boolean };
type CachedThread = { messages: MessageRecord[]; cursor: string | null };
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

const cachedThreadLimit = 20;

// A thread opened before starts from its remembered messages instead of a spinner; the fresh ones merge in.
function openedHistory(threads: Map<string, CachedThread>, key: string): History {
  const cached = key ? threads.get(key) : undefined;
  return { key, messages: cached?.messages ?? [], cursor: cached?.cursor ?? null, state: key && !cached ? "loading" : "ready", loadingOlder: false };
}

export function useConversationHistory(api: Request, lineId: string, conversationId: string, visible: boolean, onRead: (id: string) => void, userId = "") {
  const key = visible && conversationId ? `${lineId}:${conversationId}` : "";
  const scope = useRef({ key, generation: 0, latestRequest: 0 });
  if (scope.current.key !== key) scope.current = { key, generation: scope.current.generation + 1, latestRequest: 0 };
  // Most recently used threads only, and never shared with another signed-in user.
  const cache = useRef({ userId, threads: new Map<string, CachedThread>() });
  if (cache.current.userId !== userId) cache.current = { userId, threads: new Map() };
  const [history, setHistory] = useState<History>({ key: "", messages: [], cursor: null, state: "ready", loadingOlder: false });
  const olderRequest = useRef(false);
  const current = history.key === key ? history : openedHistory(cache.current.threads, key);

  const refresh = useCallback(async () => {
    if (!key || scope.current.key !== key) return;
    const generation = scope.current.generation;
    const request = ++scope.current.latestRequest;
    const isCurrent = () => scope.current.key === key && scope.current.generation === generation && scope.current.latestRequest === request;
    try {
      const page = await api<ApiPage<MessageRecord>>(`/v1/conversations/${conversationId}/messages?limit=50`);
      if (!isCurrent()) return;
      setHistory((previous) => ({ key, messages: mergeRecords(previous.key === key ? previous.messages : [], page.items), cursor: previous.key === key && previous.messages.length ? previous.cursor : page.nextCursor, state: "ready", loadingOlder: previous.key === key && previous.loadingOlder }));
      const last = page.items.at(-1);
      if (last && AppState.currentState === "active") {
        // A read-receipt failure must not hide successfully loaded messages.
        try {
          await api(`/v1/conversations/${conversationId}/read`, { method: "PUT", body: JSON.stringify({ lastReadMessageId: last.id }) });
          if (isCurrent()) onRead(conversationId);
        } catch { /* Retry the read receipt on the next refresh. */ }
      }
    } catch {
      if (isCurrent()) setHistory((previous) => ({ key, messages: previous.key === key ? previous.messages : [], cursor: previous.key === key ? previous.cursor : null, state: "error", loadingOlder: false }));
    }
  }, [api, conversationId, key, onRead]);

  useEffect(() => {
    olderRequest.current = false;
    setHistory(openedHistory(cache.current.threads, key));
    void refresh();
    return () => { scope.current.generation += 1; };
  }, [key, refresh]);

  // Remember what is shown, once it is known to belong to the open thread.
  useEffect(() => {
    if (!history.key || history.key !== scope.current.key || !history.messages.length) return;
    const { threads } = cache.current;
    threads.delete(history.key);
    threads.set(history.key, { messages: history.messages, cursor: history.cursor });
    while (threads.size > cachedThreadLimit) threads.delete(threads.keys().next().value!);
  }, [history]);

  const loadOlder = async () => {
    if (!key || !current.cursor || olderRequest.current) return;
    const generation = scope.current.generation;
    const isCurrent = () => scope.current.key === key && scope.current.generation === generation;
    olderRequest.current = true;
    setHistory((previous) => ({ ...previous, loadingOlder: true }));
    try {
      const page = await api<ApiPage<MessageRecord>>(`/v1/conversations/${conversationId}/messages?limit=50&cursor=${encodeURIComponent(current.cursor)}`);
      if (isCurrent()) setHistory((previous) => ({ ...previous, messages: mergeRecords(page.items, previous.messages), cursor: page.nextCursor, state: "ready", loadingOlder: false }));
    } catch {
      if (isCurrent()) setHistory((previous) => ({ ...previous, state: "error", loadingOlder: false }));
    } finally {
      if (isCurrent()) olderRequest.current = false;
    }
  };

  return { messages: current.messages, state: current.state, hasOlder: Boolean(current.cursor), loadingOlder: current.loadingOlder, refresh, loadOlder };
}
