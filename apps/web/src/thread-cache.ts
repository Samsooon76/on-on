import type { MessageRecord } from "@onoff/api-client";

export type CachedThread = { messages: MessageRecord[]; cursor: string | null };

/** In-memory pages of recently opened conversations, so reopening one shows them at once. */
export class ThreadCache {
  #entries = new Map<string, CachedThread>();
  #capacity: number;

  constructor(capacity = 20) { this.#capacity = capacity; }

  get(id: string): CachedThread | undefined {
    const thread = this.#entries.get(id);
    if (thread) { this.#entries.delete(id); this.#entries.set(id, thread); }
    return thread;
  }

  set(id: string, thread: CachedThread): void {
    this.#entries.delete(id);
    this.#entries.set(id, thread);
    while (this.#entries.size > this.#capacity) this.#entries.delete(this.#entries.keys().next().value as string);
  }

  delete(id: string): void { this.#entries.delete(id); }
  clear(): void { this.#entries.clear(); }
  get size(): number { return this.#entries.size; }
}

/** Fresh records win over cached ones with the same id (delivery status moves forward). */
export function mergeById<T extends { id: string }>(cached: T[], fresh: T[]): T[] {
  return [...new Map([...cached, ...fresh].map((item) => [item.id, item])).values()];
}

/**
 * Whether a fresh page can be merged into cached messages. It can when it overlaps them, or when it is the whole
 * history (no older page). Otherwise many messages arrived while the thread was closed: merging would leave a gap
 * that no cursor reaches, so the fresh page must replace the cache.
 */
export function continuesThread(cached: { id: string }[], fresh: { id: string }[], nextCursor: string | null): boolean {
  if (!cached.length) return false;
  if (nextCursor === null) return true;
  const known = new Set(cached.map((item) => item.id));
  return fresh.some((item) => known.has(item.id));
}
