import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { validateMcpClaims } from "../dist/mcp.js";

const user = "00000000-0000-4000-8000-000000000001", org = "10000000-0000-4000-8000-000000000001", line = "20000000-0000-4000-8000-000000000001", grantId = "30000000-0000-4000-8000-000000000001", draftId = "40000000-0000-4000-8000-000000000001", messageId = "50000000-0000-4000-8000-000000000001";
const config = loadConfig({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "publishable-test", SUPABASE_SECRET_KEY: "secret-test", MCP_ENABLED: "true", API_PUBLIC_URL: "https://api.example.test", WEB_PUBLIC_URL: "https://web.example.test", ALLOWED_ORIGINS: "https://web.example.test", SMS_ENABLED: "true", TWILIO_ACCOUNT_SID: "AC11111111111111111111111111111111", TWILIO_API_KEY_SID: "key", TWILIO_API_KEY_SECRET: "secret", TWILIO_AUTH_TOKEN: "token", SMS_ALLOWED_RECIPIENTS: "+33601020304", TWILIO_ALLOWED_DESTINATIONS: "+33" });
const claims = { sub: user, client_id: "assistant-client", mcp_grant_id: grantId, role: "onoff_mcp", aud: "https://api.example.test/mcp", iss: "https://example.supabase.co/auth/v1", exp: Math.floor(Date.now() / 1000) + 3600 };
const token = `test.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.test`;
function setup(t, options = {}) {
  const permissions = options.permissions ?? ["contacts:read", "messages:read", "calls:read", "contacts:write", "messages:send", "calls:prepare"];
  const rows = {
    mcp_grants: [{ id: grantId, user_id: user, client_id: claims.client_id, client_name: "Assistant", resource_url: claims.aud, organization_id: org, permissions, line_ids: [line], revoked_at: null }],
    organizations: [{ id: org, name: "Example", status: "active" }],
    memberships: [{ organization_id: org, user_id: user, status: "active" }],
    line_assignments: [{ organization_id: org, line_id: line, user_id: user, status: "active", can_sms: true, can_voice: true }],
    lines: [{ id: line, organization_id: org, status: "active", phone_number: "+33102030405", sms_enabled: true, voice_enabled: true }],
    contacts: [], contact_phones: [], calls: [], conversations: [], messages: [], mcp_audit_events: [],
    mcp_sms_drafts: [{ id: draftId, user_id: user, grant_id: grantId, organization_id: org, line_id: line, destination: "+33601020304", body: "Rendez-vous confirmé", state: "pending", expires_at: new Date(Date.now() + 600000).toISOString(), message_id: null }],
  };
  let sent = 0, prepared = 0;
  const rpcCalls = [];
  function from(table) {
    const filters = []; let update = null, insert = null, single = false, limit = Infinity;
    const q = {
      select: () => q, order: () => q, or: () => q, ilike: () => q, not: () => q,
      eq: (key, value) => { filters.push(row => row[key] === value); return q; },
      is: (key, value) => { filters.push(row => (row[key] ?? null) === value); return q; },
      in: (key, values) => { filters.push(row => values.includes(row[key])); return q; },
      limit: value => { limit = value; return q; },
      update: value => { update = value; return q; }, insert: value => { insert = value; return q; },
      maybeSingle: () => { single = true; return q; }, single: () => { single = true; return q; },
      then(resolve, reject) {
        if (insert) rows[table].push(insert);
        const result = (rows[table] ?? []).filter(row => filters.every(f => f(row))).slice(0, limit);
        if (update) result.forEach(row => Object.assign(row, update));
        return Promise.resolve({ data: single ? result[0] ?? null : result, error: null }).then(resolve, reject);
      },
    }; return q;
  }
  async function rpc(name, args) {
    rpcCalls.push({ name, args });
    if (name === "consume_api_rate_limit") return { data: !options.rateLimited, error: null };
    if (name === "mcp_write_contact") return { data: messageId, error: null };
    if (name === "mcp_prepare_sms") {
      const draft = rows.mcp_sms_drafts[0];
      if (draft.state !== "approved" && !draft.message_id) return { data: null, error: { code: "42501" } };
      const replayed = Boolean(draft.message_id);
      if (!replayed) { prepared++; draft.state = "submitted"; draft.message_id = messageId; rows.messages.push({ id: messageId, conversation_id: messageId, organization_id: org, status: "submitting", provider_message_sid: null }); }
      return { data: { messageId, conversationId: messageId, fromNumber: "+33102030405", destination: draft.destination, replayed }, error: null };
    }
    if (name === "update_outbound_message_result") {
      Object.assign(rows.messages[0], { status: args.p_status, provider_message_sid: args.p_message_sid });
      return { data: { status: args.p_status }, error: null };
    }
    return { data: null, error: null };
  }
  const app = createApp(config, {
    createSupabaseClient: () => ({ from, rpc, auth: {
      getUser: async () => ({ data: { user: { id: user, is_anonymous: false } }, error: null }),
      getClaims: async () => ({ data: { claims: options.claims ?? claims }, error: options.invalidSignature ? new Error("signature") : null }),
    } }),
    createSmsProvider: () => ({ messages: { create: async () => { sent++; if (options.timeout) throw new Error("timeout"); return { sid: "SM11111111111111111111111111111111", status: "sent" }; } } }),
  });
  t.after(() => app.close());
  function parse(response) {
    if (response.headers["content-type"]?.includes("text/event-stream")) return JSON.parse(response.body.split("\n").find(line => line.startsWith("data: ")).slice(6));
    return response.json();
  }
  async function request(method, params, extra = {}) {
    const response = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", ...extra }, payload: { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) } });
    return { response, body: parse(response) };
  }
  const call = (name, args = {}) => request("tools/call", { name, arguments: args });
  return { app, rows, request, call, sent: () => sent, prepared: () => prepared, rpcCalls };
}

test("MCP verifies resource, issuer, role, client, grant and expiration", () => {
  assert.equal(validateMcpClaims(claims, config).userId, user);
  for (const patch of [{ aud: "authenticated" }, { iss: "https://evil.test" }, { role: "authenticated" }, { client_id: "" }, { mcp_grant_id: "bad" }, { exp: 1 }, { is_anonymous: true }]) assert.throws(() => validateMcpClaims({ ...claims, ...patch }, config));
});
test("discovery and authentication challenge are available, invalid origins and signatures denied", async t => {
  const { app } = setup(t, { invalidSignature: true });
  const metadata = await app.inject("/.well-known/oauth-protected-resource/mcp");
  assert.equal(metadata.json().resource, claims.aud);
  const missing = await app.inject({ method: "POST", url: "/mcp", payload: {} });
  assert.equal(missing.statusCode, 401); assert.match(missing.headers["www-authenticate"], /resource_metadata=/);
  const invalid = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${token}` }, payload: {} });
  assert.equal(invalid.statusCode, 401);
  const origin = await app.inject({ method: "POST", url: "/mcp", headers: { origin: "https://evil.test" }, payload: {} });
  assert.equal(origin.statusCode, 403);
});
test("delegated tokens cannot bypass MCP through normal API or SMS approval routes", async t => {
  const { app } = setup(t);
  for (const [method, url, payload] of [["GET", "/v1/me"], ["POST", "/v1/messages", { organizationId: org, lineId: line, destination: "+33601020304", body: "Bypass" }], ["POST", `/v1/mcp/sms-drafts/${draftId}/decision`, { approve: true }]]) {
    const response = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
    assert.equal(response.statusCode, 403, url);
  }
});
test("official MCP SDK handles initialization, tool discovery and invocation for legacy clients", async t => {
  const { request, call } = setup(t);
  const init = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.response.statusCode, 200); assert.equal(init.body.result.serverInfo.name, "onoff");
  const list = await request("tools/list");
  assert.equal(list.body.result.tools.length, 12);
  const names = list.body.result.tools.map(tool => tool.name);
  assert.ok(names.includes("send_prepared_sms")); assert.ok(names.includes("get_sms_action"));
  const context = await call("get_context"); assert.equal(context.body.result.structuredContent.organization.id, org);
  const malformed = await call("prepare_call", { lineId: line, destination: "+33601020304", confirmed: true });
  assert.ok(malformed.body.result?.isError || malformed.body.error);
});
test("read-only consent denies writes and calls, allowed reads work", async t => {
  const { call, rpcCalls } = setup(t, { permissions: ["contacts:read"] });
  const read = await call("search_contacts", { query: "Sophie" }); assert.deepEqual(read.body.result.structuredContent.items, []);
  for (const [name, args] of [["prepare_sms", { lineId: line, destination: "+33601020304", body: "Hello", requestKey: messageId }], ["create_contact", { displayName: "Sophie", requestKey: messageId }], ["prepare_call", { lineId: line, destination: "+33601020304" }]]) {
    assert.equal((await call(name, args)).body.result.isError, true, name);
  }
  assert.equal(rpcCalls.filter(call => call.name === "mcp_write_contact").length, 0);
});
test("revocation and suspension are enforced on the next MCP request", async t => {
  const { call, rows } = setup(t);
  rows.mcp_grants[0].revoked_at = new Date().toISOString(); assert.equal((await call("get_context")).response.statusCode, 403);
  rows.mcp_grants[0].revoked_at = null; rows.memberships[0].status = "suspended"; assert.equal((await call("get_context")).response.statusCode, 403);
});
test("unselected line and another client's SMS draft cannot be accessed", async t => {
  const { call, rows } = setup(t);
  assert.equal((await call("list_calls", { lineId: messageId })).body.result.isError, true);
  rows.mcp_sms_drafts[0].grant_id = messageId;
  assert.equal((await call("get_sms_action", { id: draftId })).body.result.isError, true);
});
test("send tool requires prior human approval and replays never send twice", async t => {
  const { call, rows, sent, prepared } = setup(t);
  assert.equal((await call("send_prepared_sms", { id: draftId })).body.result.isError, true); assert.equal(sent(), 0);
  rows.mcp_sms_drafts[0].state = "approved";
  const first = await call("send_prepared_sms", { id: draftId }); assert.equal(first.body.result.structuredContent.status, "sent");
  const replay = await call("send_prepared_sms", { id: draftId }); assert.equal(replay.body.result.structuredContent.replayed, true);
  assert.equal(sent(), 1); assert.equal(prepared(), 1);
});
test("uncertain provider result stays unknown, including after a retry", async t => {
  const { call, rows, sent } = setup(t, { timeout: true }); rows.mcp_sms_drafts[0].state = "approved";
  assert.equal((await call("send_prepared_sms", { id: draftId })).body.result.structuredContent.status, "unknown");
  assert.equal((await call("send_prepared_sms", { id: draftId })).body.result.structuredContent.status, "unknown");
  assert.equal(sent(), 1);
});
test("request limits are shared and return retry information", async t => {
  const { call } = setup(t, { rateLimited: true }); const result = await call("get_context");
  assert.equal(result.response.statusCode, 429); assert.equal(result.response.headers["retry-after"], "60");
});

test("modern 2026 MCP requests use the official stateless protocol and validate metadata headers", async t => {
  const { app } = setup(t);
  const payload = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_context", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "modern-test", version: "1" } } } };
  const headers = { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "get_context" };
  const result = await app.inject({ method: "POST", url: "/mcp", headers, payload });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().result.structuredContent.organization.id, org);
  const mismatch = await app.inject({ method: "POST", url: "/mcp", headers: { ...headers, "mcp-name": "send_prepared_sms" }, payload });
  assert.equal(mismatch.statusCode, 400);
});

test("server consent uses verified user bearer with fixed Auth endpoints, never browser session SDK", async t => {
  const { app } = setup(t); const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return Response.json({ authorization_id: "consent-request", redirect_uri: "https://assistant.test/callback", scope: "openid", client: { id: "assistant-client", name: "Assistant" }, user: { id: user } });
  });
  const result = await app.inject({ method: "GET", url: "/v1/mcp/authorizations/consent-request", headers: { authorization: "Bearer user-session" } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().client.id, "assistant-client");
  assert.equal(requests[0].url, "https://example.supabase.co/auth/v1/oauth/authorizations/consent-request");
  assert.equal(requests[0].options.headers.authorization, "Bearer user-session");
  const revoked = await app.inject({ method: "POST", url: `/v1/mcp/grants/${grantId}/revoke`, headers: { authorization: "Bearer user-session" } });
  assert.equal(revoked.json().revoked, true);
  assert.equal(requests[1].options.method, "DELETE");
});

test("unused subscription streams are bounded instead of holding API requests open", { timeout: 3000 }, async t => {
  const { app } = setup(t);
  const result = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "subscriptions/listen" }, payload: { jsonrpc: "2.0", id: 2, method: "subscriptions/listen", params: { notifications: { toolsListChanged: true }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } } });
  assert.ok(result.json().error);
});
