import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { decodeCursor, encodeCursor } from "../dist/cursor.js";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const userId = uuid(10);
const organizationId = uuid(1);
const lineId = uuid(2);
const conversationId = uuid(3);
const config = {
  APP_ENV: "dev", API_HOST: "127.0.0.1", API_PORT: 4100, API_PUBLIC_URL: "http://localhost:4100", WEB_PUBLIC_URL: "http://localhost:5173",
  ALLOWED_ORIGINS: "http://localhost:5173", SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key",
  SUPABASE_SECRET_KEY: undefined, VOICE_ENABLED: false, SMS_ENABLED: false, TWILIO_ACCOUNT_SID: undefined, TWILIO_API_KEY_SID: undefined,
  TWILIO_API_KEY_SECRET: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_TWIML_APP_SID: undefined, TWILIO_ALLOWED_DESTINATIONS: "+33",
  SMS_ALLOWED_RECIPIENTS: "", MAX_ACTIVE_CALL_SECONDS: 900, MAX_RINGING_DEVICES: 4, allowedOrigins: new Set(["http://localhost:5173"]),
};
const headers = { authorization: "Bearer test-user-token" };

// Records every Supabase call so tests can assert both what is asked and how many round trips it takes.
function createBackend({ rpc = async () => ({ data: null, error: null }), single = { data: null, error: null } } = {}) {
  const calls = [];
  const client = {
    auth: {
      getClaims: async () => ({ data: { claims: { sub: userId, role: "authenticated", aud: "authenticated", is_anonymous: false } }, error: null }),
      getUser: async () => { calls.push({ kind: "auth.getUser" }); return { data: { user: { id: userId, is_anonymous: false } }, error: null }; },
    },
    rpc: async (name, args) => { calls.push({ kind: "rpc", name, args }); return rpc(name, args); },
    from: (table) => {
      const entry = { kind: "from", table, filters: [] };
      calls.push(entry);
      const query = new Proxy({}, {
        get(_target, property) {
          if (property === "then") return (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject);
          if (property === "maybeSingle") return async () => single;
          return (...args) => { entry.filters.push([property, ...args]); return query; };
        },
      });
      return query;
    },
  };
  return { calls, dependencies: { createSupabaseClient: () => client } };
}
const database = (calls) => calls.filter((call) => call.kind !== "auth.getUser");

const messageRow = (n, overrides = {}) => ({ id: uuid(100 + n), conversation_id: conversationId, body: `message ${n}`, direction: "inbound", status: "received", created_at: `2026-09-28T10:0${n}:00.123456+00:00`, ...overrides });

const inboxPayload = {
  hasMore: true,
  items: [
    { id: uuid(31), organization_id: organizationId, line_id: lineId, remote_number: "+33600000001", last_message_at: "2026-09-28T10:00:00.123456+00:00", remote_contact_name: "Alice", last_message: messageRow(1), unread: true },
    { id: uuid(32), organization_id: organizationId, line_id: lineId, remote_number: "+33600000002", last_message_at: "2026-09-28T09:00:00.654321+00:00", remote_contact_name: null, last_message: messageRow(2, { conversation_id: uuid(32) }), unread: false },
  ],
};

test("the inbox is served by one database call and keeps the response shape clients rely on", async (t) => {
  const backend = createBackend({ rpc: async () => ({ data: inboxPayload, error: null }) });
  const app = createApp(config, backend.dependencies);
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: `/v1/lines/${lineId}/conversations`, headers });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(database(backend.calls), [{ kind: "rpc", name: "list_line_conversations", args: { p_line_id: lineId, p_limit: 30 } }]);
  const body = response.json();
  assert.deepEqual(body.items[0], {
    id: uuid(31), lineId, remoteNumber: "+33600000001", remoteContactName: "Alice", lastMessageAt: "2026-09-28T10:00:00.123456+00:00", lastMessage: messageRow(1), unread: true,
  });
  assert.equal(body.items[1].remoteContactName, null);
  assert.equal(body.items[1].unread, false);
  // The next page starts after the last item, with its timestamp untouched.
  assert.deepEqual(decodeCursor(body.nextCursor, { exact: true }), { createdAt: "2026-09-28T09:00:00.654321+00:00", id: uuid(32) });
});

test("the last inbox page has no cursor and a cursor is passed to the database unrounded", async (t) => {
  const backend = createBackend({ rpc: async () => ({ data: { hasMore: false, items: inboxPayload.items }, error: null }) });
  const app = createApp(config, backend.dependencies);
  t.after(() => app.close());
  const cursor = encodeCursor({ last_message_at: "2026-09-28T09:00:00.654321+00:00", id: uuid(32) });

  const response = await app.inject({ method: "GET", url: `/v1/lines/${lineId}/conversations?limit=50&cursor=${cursor}`, headers });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().nextCursor, null);
  assert.deepEqual(database(backend.calls)[0].args, { p_line_id: lineId, p_limit: 50, p_cursor_at: "2026-09-28T09:00:00.654321+00:00", p_cursor_id: uuid(32) });
});

test("conversation and call lists refuse invalid input before touching the database", async (t) => {
  const backend = createBackend();
  const app = createApp(config, backend.dependencies);
  t.after(() => app.close());
  const forgedTimestamp = Buffer.from(JSON.stringify({ createdAt: "yesterday", id: uuid(32) })).toString("base64url");
  const badId = Buffer.from(JSON.stringify({ createdAt: "2026-09-28T09:00:00.000Z", id: "nope" })).toString("base64url");

  for (const path of ["conversations", "calls"]) {
    for (const url of [`/v1/lines/not-a-uuid/${path}`, `/v1/lines/${lineId}/${path}?limit=0`, `/v1/lines/${lineId}/${path}?limit=101`, `/v1/lines/${lineId}/${path}?cursor=garbage`, `/v1/lines/${lineId}/${path}?cursor=${forgedTimestamp}`, `/v1/lines/${lineId}/${path}?cursor=${badId}`]) {
      const response = await app.inject({ method: "GET", url, headers });
      assert.equal(response.statusCode, 400, url);
    }
  }
  assert.equal((await app.inject({ method: "GET", url: `/v1/lines/${lineId}/conversations` })).statusCode, 401);
  assert.deepEqual(backend.calls, []);
});

test("a line without access is not found and database problems are reported as unavailable", async (t) => {
  for (const [path, name] of [["conversations", "list_line_conversations"], ["calls", "list_line_calls"]]) {
    const denied = createBackend({ rpc: async () => ({ data: null, error: null }) });
    const deniedApp = createApp(config, denied.dependencies);
    t.after(() => deniedApp.close());
    const notFound = await deniedApp.inject({ method: "GET", url: `/v1/lines/${lineId}/${path}`, headers });
    assert.equal(notFound.statusCode, 404, name);
    assert.equal(notFound.json().code, "not_found");
    assert.equal(database(denied.calls).length, 1, "the access decision needs no extra round trip");

    const failing = createBackend({ rpc: async () => ({ data: null, error: { code: "57014", message: "canceling statement" } }) });
    const failingApp = createApp(config, failing.dependencies);
    t.after(() => failingApp.close());
    assert.equal((await failingApp.inject({ method: "GET", url: `/v1/lines/${lineId}/${path}`, headers })).statusCode, 503, name);

    const malformed = createBackend({ rpc: async () => ({ data: { items: "unexpected" }, error: null }) });
    const malformedApp = createApp(config, malformed.dependencies);
    t.after(() => malformedApp.close());
    assert.equal((await malformedApp.inject({ method: "GET", url: `/v1/lines/${lineId}/${path}`, headers })).statusCode, 503, `${name} with an unexpected payload`);
  }
});

test("call history is one database call with contact labels and a stable cursor", async (t) => {
  const items = [
    { id: uuid(41), organization_id: organizationId, line_id: lineId, direction: "inbound", remote_number: "+33600000001", status: "completed", started_at: "2026-09-28T10:00:01.000000+00:00", answered_at: null, ended_at: null, duration_seconds: 42, created_at: "2026-09-28T10:00:00.111111+00:00", remote_contact_name: "Alice" },
    { id: uuid(42), organization_id: organizationId, line_id: lineId, direction: "outbound", remote_number: "+33600000009", status: "missed", started_at: null, answered_at: null, ended_at: null, duration_seconds: null, created_at: "2026-09-28T09:00:00.222222+00:00", remote_contact_name: null },
  ];
  const backend = createBackend({ rpc: async () => ({ data: { hasMore: true, items }, error: null }) });
  const app = createApp(config, backend.dependencies);
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: `/v1/lines/${lineId}/calls?limit=2`, headers });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(database(backend.calls), [{ kind: "rpc", name: "list_line_calls", args: { p_line_id: lineId, p_limit: 2 } }]);
  const body = response.json();
  assert.equal(body.items[0].remoteContactName, "Alice");
  assert.equal(body.items[0].duration_seconds, 42);
  assert.equal(body.items[1].remoteContactName, null);
  assert.equal("remote_contact_name" in body.items[0], false, "the SQL field name never leaks to clients");
  assert.deepEqual(decodeCursor(body.nextCursor, { exact: true }), { createdAt: "2026-09-28T09:00:00.222222+00:00", id: uuid(42) });
});

test("a conversation thread is one database call, oldest message first, paged from its oldest message", async (t) => {
  const newestFirst = [messageRow(3), messageRow(2), messageRow(1)].map((row) => ({ ...row, provider_error_code: null, sent_at: null, delivered_at: null }));
  const payload = { conversation: { id: conversationId, organization_id: organizationId, line_id: lineId, remote_number: "+33600000001" }, hasMore: true, items: newestFirst };
  const backend = createBackend({ rpc: async () => ({ data: payload, error: null }) });
  const app = createApp(config, backend.dependencies);
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: `/v1/conversations/${conversationId}/messages?limit=3`, headers });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(database(backend.calls), [{ kind: "rpc", name: "conversation_thread", args: { p_conversation_id: conversationId, p_limit: 3 } }]);
  const body = response.json();
  assert.deepEqual(body.conversation, payload.conversation);
  assert.deepEqual(body.items.map((item) => item.body), ["message 1", "message 2", "message 3"]);
  assert.deepEqual(decodeCursor(body.nextCursor, { exact: true }), { createdAt: messageRow(1).created_at, id: messageRow(1).id });

  const older = await app.inject({ method: "GET", url: `/v1/conversations/${conversationId}/messages?cursor=${body.nextCursor}`, headers });
  assert.equal(older.statusCode, 200);
  assert.deepEqual(database(backend.calls)[1].args, { p_conversation_id: conversationId, p_limit: 30, p_cursor_at: messageRow(1).created_at, p_cursor_id: messageRow(1).id });
});

test("a thread that is not visible is not found; invalid identifiers never reach the database", async (t) => {
  const backend = createBackend({ rpc: async () => ({ data: null, error: null }) });
  const app = createApp(config, backend.dependencies);
  t.after(() => app.close());

  assert.equal((await app.inject({ method: "GET", url: `/v1/conversations/${conversationId}/messages`, headers })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/v1/conversations/not-a-uuid/messages", headers })).statusCode, 400);
  assert.equal(database(backend.calls).length, 1);
});

test("marking a conversation read is one database call whose outcome maps to a clear status", async (t) => {
  const outcomes = [["ok", 204], ["not_found", 404], ["invalid_message", 400], ["something-else", 503]];
  for (const [result, status] of outcomes) {
    const backend = createBackend({ rpc: async () => ({ data: result, error: null }) });
    const app = createApp(config, backend.dependencies);
    t.after(() => app.close());
    const response = await app.inject({ method: "PUT", url: `/v1/conversations/${conversationId}/read`, headers, payload: { lastReadMessageId: uuid(101) } });
    assert.equal(response.statusCode, status, result);
    assert.deepEqual(database(backend.calls), [{ kind: "rpc", name: "mark_conversation_read", args: { p_conversation_id: conversationId, p_last_read_message_id: uuid(101) } }]);
  }

  const backend = createBackend({ rpc: async () => ({ data: "ok", error: null }) });
  const app = createApp(config, backend.dependencies);
  t.after(() => app.close());
  await app.inject({ method: "PUT", url: `/v1/conversations/${conversationId}/read`, headers, payload: { lastReadMessageId: null } });
  await app.inject({ method: "PUT", url: `/v1/conversations/${conversationId}/read`, headers, payload: {} });
  assert.deepEqual(database(backend.calls).map((call) => call.args), [{ p_conversation_id: conversationId }, { p_conversation_id: conversationId }], "no marker means the argument is omitted");
  assert.equal(backend.calls.filter((call) => call.kind === "auth.getUser").length, 2, "read markers are writes and keep the authoritative session check");

  const denied = createBackend({ rpc: async () => ({ data: null, error: { code: "42501", message: "denied" } }) });
  const deniedApp = createApp(config, denied.dependencies);
  t.after(() => deniedApp.close());
  const forbidden = await deniedApp.inject({ method: "PUT", url: `/v1/conversations/${conversationId}/read`, headers, payload: {} });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().code, "read_state_not_updated");
  const broken = createBackend({ rpc: async () => ({ data: null, error: { code: "08006", message: "connection" } }) });
  const brokenApp = createApp(config, broken.dependencies);
  t.after(() => brokenApp.close());
  assert.equal((await brokenApp.inject({ method: "PUT", url: `/v1/conversations/${conversationId}/read`, headers, payload: {} })).statusCode, 503);
});

test("devices are one query scoped to the caller; row level security handles the organizations", async (t) => {
  const backend = createBackend();
  const app = createApp(config, backend.dependencies);
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/v1/devices", headers });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { items: [] });
  const queries = database(backend.calls);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].table, "devices");
  assert.ok(queries[0].filters.some(([kind, column, value]) => kind === "eq" && column === "user_id" && value === userId));
});

test("contact lookups are single queries and a hidden contact is not found", async (t) => {
  const contactId = uuid(60);
  const backend = createBackend();
  const app = createApp(config, backend.dependencies);
  t.after(() => app.close());

  assert.equal((await app.inject({ method: "GET", url: `/v1/contacts/${contactId}`, headers })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: `/v1/contacts/${contactId}`, headers })).statusCode, 404);
  assert.equal((await app.inject({ method: "PATCH", url: `/v1/contacts/${contactId}`, headers, payload: { displayName: "Alice", email: null, version: 1, phones: [] } })).statusCode, 404);
  assert.deepEqual(database(backend.calls).map((call) => call.table), ["contacts", "contacts", "contacts"], "no membership lookup before the contact query");
});
