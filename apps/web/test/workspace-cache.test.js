import test from "node:test";
import assert from "node:assert/strict";
import { createSnapshot } from "@onoff/api-client";
import { ThreadCache, mergeById } from "../src/thread-cache.ts";
import { clearWorkspaceSnapshot, loadWorkspaceSnapshot, saveWorkspaceSnapshot, snapshotSignature } from "../src/workspace-snapshot.ts";

const message = (id, status = "received") => ({ id, direction: "inbound", body: id, status, provider_error_code: null, created_at: "2026-09-28T09:00:00Z", sent_at: null, delivered_at: null });

test("reopened threads come from memory, the least recently used one leaves first", () => {
  const cache = new ThreadCache(2);
  cache.set("a", { messages: [message("a1")], cursor: null });
  cache.set("b", { messages: [message("b1")], cursor: "older" });
  assert.equal(cache.get("a")?.messages[0].id, "a1", "reading a thread refreshes its position");
  cache.set("c", { messages: [message("c1")], cursor: null });
  assert.equal(cache.get("b"), undefined, "b was the least recently used");
  assert.deepEqual([cache.get("a")?.messages[0].id, cache.get("c")?.messages[0].id], ["a1", "c1"]);
  assert.equal(cache.size, 2);
  cache.set("a", { messages: [message("a2")], cursor: null });
  assert.equal(cache.size, 2, "replacing a thread does not grow the cache");
  assert.equal(cache.get("a")?.messages[0].id, "a2");
  cache.delete("a");
  assert.equal(cache.get("a"), undefined);
  cache.clear();
  assert.equal(cache.size, 0);
});

test("fresh records replace cached ones with the same id and older cached pages are kept", () => {
  const merged = mergeById([message("old"), message("recent", "sent")], [message("recent", "delivered"), message("new")]);
  assert.deepEqual(merged.map((item) => item.id), ["old", "recent", "new"]);
  assert.equal(merged.find((item) => item.id === "recent").status, "delivered");
});

// A tiny Storage double: values are strings and any operation can be made to fail.
function memoryStorage({ failing = false } = {}) {
  const values = new Map();
  const guard = () => { if (failing) throw new DOMException("blocked", "SecurityError"); };
  return { values, getItem: (key) => { guard(); return values.get(key) ?? null; }, setItem: (key, value) => { guard(); values.set(key, value); }, removeItem: (key) => { guard(); values.delete(key); } };
}
const conversation = { id: "conversation-1", lineId: "line-1", remoteNumber: "+33600000001", remoteContactName: "Alice", lastMessageAt: "2026-09-28T09:00:00Z", lastMessage: { id: "m1", body: "Bonjour", direction: "inbound", status: "received", created_at: "2026-09-28T09:00:00Z" }, unread: true };
const snapshot = (overrides = {}) => createSnapshot({ userId: "user-1", organizationId: "org-1", lineId: "line-1", organizations: [{ organization_id: "org-1" }], lines: [{ can_sms: true, lines: { id: "line-1" } }], conversations: [conversation], calls: [], ...overrides });

test("the last inbox is stored per user and restored", () => {
  const storage = memoryStorage();
  saveWorkspaceSnapshot(snapshot(), storage);
  assert.equal([...storage.values.keys()].length, 1);
  assert.equal(loadWorkspaceSnapshot("user-1", storage)?.conversations[0].remoteContactName, "Alice");
  assert.equal(loadWorkspaceSnapshot("user-2", storage), null, "another user gets nothing");
  clearWorkspaceSnapshot("user-1", storage);
  assert.equal(storage.values.size, 0, "sign-out leaves no numbers or previews behind");
  assert.equal(loadWorkspaceSnapshot("user-1", storage), null);
});

test("blocked or full storage never breaks the app", () => {
  const blocked = memoryStorage({ failing: true });
  assert.doesNotThrow(() => saveWorkspaceSnapshot(snapshot(), blocked));
  assert.equal(loadWorkspaceSnapshot("user-1", blocked), null);
  assert.doesNotThrow(() => clearWorkspaceSnapshot("user-1", blocked));
  assert.equal(loadWorkspaceSnapshot("user-1", null), null);
  assert.doesNotThrow(() => saveWorkspaceSnapshot(snapshot(), null));
  assert.doesNotThrow(() => clearWorkspaceSnapshot("", memoryStorage()));
});

test("identical inbox content has the same signature whenever it was written", () => {
  const first = snapshot();
  const later = { ...snapshot(), savedAt: first.savedAt + 60_000 };
  assert.equal(snapshotSignature(first), snapshotSignature(later));
  assert.notEqual(snapshotSignature(first), snapshotSignature(snapshot({ conversations: [{ ...conversation, unread: false }] })));
});
