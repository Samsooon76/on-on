import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiPage } from "@onoff/api-client";
import type { Contact } from "./conversation-model";

type Loader = (query: string, cursor: string | null, signal: AbortSignal) => Promise<ApiPage<Contact>>;

export function useContacts(scope: string, query: string, load: Loader) {
  const loader = useRef(load); loader.current = load;
  const key = `${scope}:${query}`;
  const current = useRef(key); current.current = key;
  const request = useRef<AbortController | null>(null);
  const [result, setResult] = useState<{ key: string; page: ApiPage<Contact> } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const page = result?.key === key ? result.page : null;

  const refresh = useCallback(async () => {
    if (current.current !== key) return;
    request.current?.abort();
    if (!scope) { setResult(null); setState("ready"); return; }
    const controller = new AbortController(); request.current = controller;
    setState("loading"); setLoadingMore(false); setError("");
    try {
      const page = await loader.current(query, null, controller.signal);
      if (!controller.signal.aborted && current.current === key) { setResult({ key, page }); setState("ready"); }
    } catch (cause) {
      if (!controller.signal.aborted && current.current === key) {
        setState("error"); setError(cause instanceof Error ? cause.message : "Les contacts sont indisponibles.");
      }
    }
  }, [scope, query, key]);

  useEffect(() => {
    setState(scope ? "loading" : "ready"); setError(""); setLoadingMore(false);
    const timer = setTimeout(() => void refresh(), 200);
    return () => { clearTimeout(timer); request.current?.abort(); };
  }, [refresh, scope]);

  async function more() {
    if (current.current !== key || !page?.nextCursor || loadingMore || state === "loading") return;
    const controller = new AbortController(); request.current = controller;
    setLoadingMore(true); setError("");
    try {
      const next = await loader.current(query, page.nextCursor, controller.signal);
      if (!controller.signal.aborted && current.current === key) {
        setResult({ key, page: { items: [...new Map([...page.items, ...next.items].map(item => [item.id, item])).values()], nextCursor: next.nextCursor } });
      }
    } catch (cause) {
      if (!controller.signal.aborted && current.current === key) setError(cause instanceof Error ? cause.message : "La suite des contacts est indisponible.");
    } finally { if (!controller.signal.aborted && current.current === key) setLoadingMore(false); }
  }
  return { contacts: page?.items ?? [], state, error, hasMore: Boolean(page?.nextCursor), loadingMore, refresh, more };
}
