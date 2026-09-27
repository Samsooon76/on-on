import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerCallFollowups } from "../dist/call-followups.js";

const org = "10000000-0000-4000-8000-000000000001", user = "20000000-0000-4000-8000-000000000001";
const call = "30000000-0000-4000-8000-000000000001", contact = "40000000-0000-4000-8000-000000000001";
const intent = "50000000-0000-4000-8000-000000000001", id = "60000000-0000-4000-8000-000000000001";
const sid = `CA${"1".repeat(32)}`;
const payload = { id, kind: "ticket", title: "Erreur de facturation", description: "Vérifier la facture de septembre.", providerCallSid: sid, contactId: contact };

function setup(t) {
  const state = { member: true, allowed: true, error: false, tables: {
    memberships: [{ organization_id: org, user_id: user, status: "active", role: "member" }],
    calls: [{ id: call, organization_id: org, remote_number: "+33601020304" }],
    call_legs: [{ call_id: call, organization_id: org, provider_call_sid: sid }],
    call_intents: [{ id: intent, organization_id: org, user_id: user, consumed_call_sid: sid }],
    contacts: [{ id: contact, organization_id: org, archived_at: null }], call_followups: [],
  } };
  const db = (server = false) => ({ from(table) {
    let filters = [], single = false, insert, update, limit = Infinity;
    const q = {
      select() { return q; }, eq(key, value) { filters.push(row => row[key] === value); return q; },
      is(key, value) { return q.eq(key, value); }, order() { return q; }, limit(value) { limit = value; return q; }, or() { return q; },
      maybeSingle() { single = true; return q; }, single() { single = true; return q; },
      insert(value) { insert = value; return q; }, update(value) { update = value; return q; },
      then(resolve, reject) {
        if (state.error) return Promise.resolve({ data: null, error: { code: "08006" } }).then(resolve, reject);
        const visible = server || (table === "memberships" ? state.member : state.allowed);
        let rows = visible ? state.tables[table].filter(row => filters.every(filter => filter(row))) : [];
        if (insert) {
          if (!visible) return Promise.resolve({ data: null, error: { code: "42501" } }).then(resolve, reject);
          if (state.tables[table].some(row => row.id === insert.id)) return Promise.resolve({ data: null, error: { code: "23505" } }).then(resolve, reject);
          const row = { ...insert, status: "open", created_at: "2026-09-27T09:00:00Z" };
          state.tables[table].push(row); rows = [row];
        }
        if (update) rows.forEach(row => Object.assign(row, update));
        if (table === "call_followups") rows = rows.map(row => ({ ...row, calls: { remote_number: state.tables.calls.find(item => item.id === row.call_id)?.remote_number } }));
        rows = rows.slice(0, limit);
        return Promise.resolve({ data: structuredClone(single ? rows[0] ?? null : rows), error: null }).then(resolve, reject);
      },
    }; return q;
  } });
  const app = Fastify();
  app.decorateRequest("context", null);
  app.addHook("preHandler", async (req, reply) => {
    if (!req.headers.authorization) return reply.code(401).send();
    req.context = { userId: user, supabase: db() };
  });
  app.setErrorHandler((error, req, reply) => reply.code(error.statusCode ?? (error.name === "ZodError" ? 400 : 500)).send({ message: error.message }));
  registerCallFollowups(app, db(true)); t.after(() => app.close());
  const request = (method, url, body) => app.inject({ method, url, headers: { authorization: "Bearer test" }, ...(body ? { payload: body } : {}) });
  return { app, state, request };
}
const endpoint = `/v1/organizations/${org}/call-followups`;

test("followups require authentication, membership and call visibility", async t => {
  const { app, state, request } = setup(t);
  assert.equal((await app.inject(endpoint)).statusCode, 401);
  state.member = false;
  assert.equal((await request("POST", endpoint, payload)).statusCode, 403);
  state.member = true; state.allowed = false;
  assert.equal((await request("POST", endpoint, payload)).statusCode, 404);
  assert.equal(state.tables.call_followups.length, 0);
});
test("creates a ticket against the authorized provider call and shared contact", async t => {
  const { request, state } = setup(t);
  const response = await request("POST", endpoint, payload);
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().call_id, call);
  assert.equal(response.json().remote_number, "+33601020304");
  assert.equal(response.json().contact_id, contact);
  assert.equal(state.tables.call_followups[0].created_by, user);
});
test("retry after a lost response returns the same record; changed input cannot reuse the key", async t => {
  const { request, state } = setup(t);
  assert.equal((await request("POST", endpoint, payload)).statusCode, 201);
  assert.equal((await request("POST", endpoint, payload)).statusCode, 200);
  assert.equal((await request("POST", endpoint, { ...payload, title: "Autre demande" })).statusCode, 409);
  assert.equal(state.tables.call_followups.length, 1);
});
test("outbound calls can resolve by intent after hangup; unresolved intents keep the form retryable", async t => {
  const { request, state } = setup(t);
  const { providerCallSid, ...input } = payload;
  const response = await request("POST", endpoint, { ...input, intentId: intent, kind: "deal", amount: 1234.56 });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().amount, 1234.56);
  state.tables.call_intents[0].consumed_call_sid = null;
  assert.equal((await request("POST", endpoint, { ...input, intentId: intent })).statusCode, 409);
});
test("rejects other organizations, other users' intents, archived contacts and unknown call IDs", async t => {
  const { request, state } = setup(t);
  const { providerCallSid, ...input } = payload;
  state.tables.call_intents[0].user_id = contact;
  assert.equal((await request("POST", endpoint, { ...input, intentId: intent })).statusCode, 409);
  state.tables.call_legs[0].organization_id = contact;
  assert.equal((await request("POST", endpoint, payload)).statusCode, 409);
  state.tables.call_legs[0].organization_id = org;
  state.tables.contacts[0].archived_at = "2026-09-27T10:00:00Z";
  assert.equal((await request("POST", endpoint, payload)).statusCode, 400);
  assert.equal((await request("POST", endpoint, { ...input, callId: contact })).statusCode, 404);
  assert.equal(state.tables.call_followups.length, 0);
});
test("validation rejects forged fields, invalid amounts and blank titles", async t => {
  const { request } = setup(t);
  for (const input of [{ ...payload, title: " " }, { ...payload, amount: 42 }, { ...payload, kind: "deal", amount: -1 }, { ...payload, kind: "deal", amount: 1.001 }, { ...payload, created_by: contact }, { ...payload, remote_number: "+33699999999" }]) {
    assert.equal((await request("POST", endpoint, input)).statusCode, 400);
  }
});
test("lists durable items and restricts ticket and deal statuses", async t => {
  const { request, state } = setup(t);
  await request("POST", endpoint, payload);
  assert.equal((await request("GET", endpoint)).json().items[0].id, id);
  assert.equal((await request("PATCH", `/v1/call-followups/${id}`, { status: "won" })).statusCode, 400);
  assert.equal((await request("PATCH", `/v1/call-followups/${id}`, { status: "closed" })).json().status, "closed");
  assert.equal((await request("PATCH", `/v1/call-followups/${id}`, { status: "open", call_id: contact })).statusCode, 400);
  assert.equal((await request("GET", `${endpoint}?cursor=invalid`)).statusCode, 400);
  state.allowed = false;
  assert.equal((await request("GET", endpoint)).json().items.length, 0);
  assert.equal((await request("PATCH", `/v1/call-followups/${id}`, { status: "open" })).statusCode, 404);
});
test("database failure is reported without a successful creation", async t => {
  const { request, state } = setup(t); state.error = true;
  assert.equal((await request("POST", endpoint, payload)).statusCode, 503);
  assert.equal(state.tables.call_followups.length, 0);
});
