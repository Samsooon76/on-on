import test from "node:test";
import assert from "node:assert/strict";
import { SNAPSHOT_HISTORY_LIMIT, SNAPSHOT_MAX_AGE_MS, SNAPSHOT_VERSION, createSnapshot, parseSnapshot, snapshotKey } from "../dist/index.js";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const message = (n) => ({ id: `message-${n}`, body: `Bonjour ${n}`, direction: "inbound", status: "received", created_at: new Date(NOW - n * 60_000).toISOString() });
const conversation = (n, lineId = "line-1") => ({ id: `conversation-${String(n).padStart(3, "0")}`, lineId, remoteNumber: `+336000000${String(n).padStart(2, "0")}`, remoteContactName: n % 2 ? "Alice" : null, lastMessageAt: new Date(NOW - n * 60_000).toISOString(), lastMessage: { ...message(n), conversation_id: `conversation-${n}` }, unread: n % 3 === 0 });
const call = (n) => ({ id: `call-${String(n).padStart(3, "0")}`, direction: n % 2 ? "inbound" : "outbound", remote_number: "+33600000001", remoteContactName: null, status: "completed", created_at: new Date(NOW - n * 60_000).toISOString(), duration_seconds: n % 2 ? 30 : null });
const input = (overrides = {}) => ({
  userId: "user-1", organizationId: "org-1", lineId: "line-1",
  organizations: [{ organization_id: "org-1", role: "admin", organizations: { id: "org-1", name: "Acme" } }],
  lines: [{ can_voice: true, can_sms: true, lines: { id: "line-1", phone_number: "+33102030405" } }],
  conversations: [conversation(2), conversation(1), conversation(3)], calls: [call(2), call(1)], ...overrides,
});
const stored = (snapshot) => JSON.stringify(snapshot);

test("a snapshot round-trips and lists the newest items first", () => {
  const restored = parseSnapshot(stored(createSnapshot(input(), NOW)), "user-1", NOW + 1000);
  assert.ok(restored);
  assert.deepEqual(restored.conversations.map((item) => item.id), ["conversation-001", "conversation-002", "conversation-003"]);
  assert.deepEqual(restored.calls.map((item) => item.id), ["call-001", "call-002"]);
  assert.equal(restored.organizationId, "org-1");
  assert.equal(restored.lines.length, 1);
  assert.equal(snapshotKey("user-1"), `onoff.workspace.v${SNAPSHOT_VERSION}.user-1`);
});

test("only the newest items of the selected line are kept", () => {
  const many = Array.from({ length: SNAPSHOT_HISTORY_LIMIT + 25 }, (_, index) => conversation(index + 1));
  const otherLine = conversation(99, "line-2");
  const snapshot = createSnapshot(input({ conversations: [...many, otherLine], calls: Array.from({ length: 90 }, (_, index) => call(index + 1)) }), NOW);
  assert.equal(snapshot.conversations.length, SNAPSHOT_HISTORY_LIMIT);
  assert.equal(snapshot.calls.length, SNAPSHOT_HISTORY_LIMIT);
  assert.equal(snapshot.conversations[0].id, "conversation-001");
  assert.ok(snapshot.conversations.every((item) => item.lineId === "line-1"), "history of another line never leaks in");
});

test("a snapshot is refused for another user, another version, or when too old", () => {
  const raw = stored(createSnapshot(input(), NOW));
  assert.ok(parseSnapshot(raw, "user-1", NOW));
  assert.equal(parseSnapshot(raw, "user-2", NOW), null, "another user");
  assert.equal(parseSnapshot(stored({ ...createSnapshot(input(), NOW), version: SNAPSHOT_VERSION + 1 }), "user-1", NOW), null, "another version");
  assert.ok(parseSnapshot(raw, "user-1", NOW + SNAPSHOT_MAX_AGE_MS));
  assert.equal(parseSnapshot(raw, "user-1", NOW + SNAPSHOT_MAX_AGE_MS + 1), null, "expired");
  assert.equal(parseSnapshot(stored({ ...createSnapshot(input(), NOW + 3_600_000) }), "user-1", NOW), null, "written in the future");
});

test("damaged, missing or tampered content is ignored instead of throwing", () => {
  const good = createSnapshot(input(), NOW);
  const cases = [
    null, undefined, "", "not json", "null", "[]", "42",
    stored({ ...good, organizationId: "" }), stored({ ...good, lineId: 7 }),
    stored({ ...good, lines: "nope" }), stored({ ...good, organizations: [1] }),
    stored({ ...good, conversations: [{ id: "c" }] }),
    stored({ ...good, conversations: [{ ...good.conversations[0], lineId: "line-2" }] }),
    stored({ ...good, conversations: [{ ...good.conversations[0], unread: "yes" }] }),
    stored({ ...good, conversations: [{ ...good.conversations[0], lastMessage: { id: 1 } }] }),
    stored({ ...good, calls: [{ id: "call", direction: "sideways", remote_number: "+33", status: "x", created_at: "t", duration_seconds: null, remoteContactName: null }] }),
    stored({ ...good, savedAt: "yesterday" }),
  ];
  for (const raw of cases) assert.equal(parseSnapshot(raw, "user-1", NOW), null, String(raw).slice(0, 60));
});

test("a conversation without any message yet is still valid", () => {
  const empty = { ...conversation(5), lastMessage: null, lastMessageAt: null };
  const restored = parseSnapshot(stored(createSnapshot(input({ conversations: [empty] }), NOW)), "user-1", NOW);
  assert.equal(restored?.conversations[0].lastMessage, null);
});
