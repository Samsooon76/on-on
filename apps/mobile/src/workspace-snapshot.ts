import { parseSnapshot, snapshotKey, type WorkspaceSnapshot } from "@onoff/api-client";
import * as SecureStore from "expo-secure-store";

// The last known inbox, kept in the device keychain so a cold start can show it before anything is fetched.
// It holds phone numbers and message previews: it is deleted on sign-out, and every failure (locked keychain,
// damaged content) simply means a normal load. Keychain values stay small, so the JSON is stored as chunks:
// the meta entry announces the chunk count and a nonce that every chunk repeats, which makes an interrupted
// or mixed-up write read as "no snapshot".

export type SnapshotStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
};
type SnapshotOrganization = { organization_id: string };
type SnapshotLine = { lines: { id: string } | null };

export const CHUNK_SIZE = 1500;
const MAX_CHUNKS = 200;

const keychainStorage: SnapshotStorage = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  deleteItem: (key) => SecureStore.deleteItemAsync(key),
};

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

export function splitChunks(text: string, size: number = CHUNK_SIZE): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + size, text.length);
    // Half of an emoji is not valid text for the keychain: keep surrogate pairs whole.
    if (end < text.length && end - start > 1 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export function joinChunks(chunks: string[]): string {
  return chunks.join("");
}

// SecureStore keys only allow letters, digits, ".", "-" and "_".
function keysFor(userId: string) {
  const base = snapshotKey(userId).replace(/[^\w.-]/g, "_");
  return { meta: `${base}.meta`, chunk: (index: number) => `${base}.${index}` };
}

function parseMeta(raw: string | null): { nonce: string; count: number } | null {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (typeof value !== "object" || value === null) return null;
    const { nonce, count } = value as { nonce?: unknown; count?: unknown };
    return typeof nonce === "string" && nonce && typeof count === "number" && Number.isInteger(count) && count > 0 && count <= MAX_CHUNKS ? { nonce, count } : null;
  } catch {
    return null;
  }
}

const newNonce = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// One operation at a time per storage: a clear can never be undone by a write that was still running.
const queues = new WeakMap<SnapshotStorage, Promise<unknown>>();
function enqueue<T>(storage: SnapshotStorage, task: () => Promise<T>, fallback: T): Promise<T> {
  const result = (queues.get(storage) ?? Promise.resolve()).then(task).catch(() => fallback);
  queues.set(storage, result);
  return result;
}

async function remove(storage: SnapshotStorage, userId: string): Promise<void> {
  const keys = keysFor(userId);
  const meta = parseMeta(await storage.getItem(keys.meta));
  // Chunks first: if this stops halfway, the meta still names every chunk and the next attempt finishes the job.
  await Promise.all(Array.from({ length: meta?.count ?? 0 }, (_, index) => storage.deleteItem(keys.chunk(index))));
  await storage.deleteItem(keys.meta);
}

const usable = (snapshot: WorkspaceSnapshot<SnapshotOrganization, SnapshotLine>) =>
  snapshot.organizations.some((item) => item.organization_id === snapshot.organizationId) && snapshot.lines.some((item) => item.lines?.id === snapshot.lineId);

/** The stored snapshot of this user, or null when there is none worth showing. Never rejects. */
export function loadSnapshot<Organization extends SnapshotOrganization, Line extends SnapshotLine>(userId: string, storage: SnapshotStorage = keychainStorage, now: number = Date.now()): Promise<WorkspaceSnapshot<Organization, Line> | null> {
  return enqueue(storage, async () => {
    const keys = keysFor(userId);
    const meta = parseMeta(await storage.getItem(keys.meta));
    if (!meta) return null;
    const prefix = `${meta.nonce}:`;
    const parts = await Promise.all(Array.from({ length: meta.count }, (_, index) => storage.getItem(keys.chunk(index))));
    const snapshot = parts.every((part) => part?.startsWith(prefix))
      ? parseSnapshot<Organization, Line>(joinChunks(parts.map((part) => part!.slice(prefix.length))), userId, now)
      : null;
    if (snapshot && usable(snapshot)) return snapshot;
    // Torn, expired or from another version: it will never be read, so it should not stay on the device.
    await remove(storage, userId);
    return null;
  }, null);
}

/** Replaces the stored snapshot of its user. Resolves whether it was written; never rejects. */
export function saveSnapshot(snapshot: WorkspaceSnapshot<unknown, unknown>, storage: SnapshotStorage = keychainStorage, nonce: string = newNonce()): Promise<boolean> {
  return enqueue(storage, async () => {
    if (!snapshot.userId) return false;
    const keys = keysFor(snapshot.userId);
    const chunks = splitChunks(JSON.stringify(snapshot));
    if (!chunks.length || chunks.length > MAX_CHUNKS) return false;
    const previous = parseMeta(await storage.getItem(keys.meta));
    // Leftovers of a longer snapshot go first, then the meta announces this write, then its chunks follow.
    await Promise.all(Array.from({ length: Math.max((previous?.count ?? 0) - chunks.length, 0) }, (_, index) => storage.deleteItem(keys.chunk(chunks.length + index))));
    await storage.setItem(keys.meta, JSON.stringify({ nonce, count: chunks.length }));
    await Promise.all(chunks.map((chunk, index) => storage.setItem(keys.chunk(index), `${nonce}:${chunk}`)));
    return true;
  }, false);
}

/** Deletes the stored snapshot of this user. Never rejects. */
export function clearSnapshot(userId: string, storage: SnapshotStorage = keychainStorage): Promise<void> {
  return enqueue(storage, () => remove(storage, userId), undefined);
}

/** Identifies a snapshot's content regardless of when it was written, to skip identical rewrites. */
export function snapshotSignature(snapshot: WorkspaceSnapshot<unknown, unknown>): string {
  const { savedAt: _savedAt, ...content } = snapshot;
  return JSON.stringify(content);
}
