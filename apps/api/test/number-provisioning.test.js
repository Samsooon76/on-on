import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createApp } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";

const orgId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000010";
const accountSid = `AC${"1".repeat(32)}`;
const config = loadConfig({
  SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "publishable-test-key", SUPABASE_SECRET_KEY: "server-test-key",
  TWILIO_ACCOUNT_SID: accountSid, TWILIO_API_KEY_SID: `SK${"2".repeat(32)}`, TWILIO_API_KEY_SECRET: "test-secret",
  TWILIO_AUTH_TOKEN: "test-auth", TWILIO_TWIML_APP_SID: `AP${"3".repeat(32)}`, VOICE_ENABLED: "true", API_PUBLIC_URL: "https://api.example.com",
});
const headers = { authorization: "Bearer test-session" };

function setup(t, options = {}) {
  const state = {
    role: "admin", monthlyPrice: 1.15, purchaseCalls: [], owned: [], regulations: [], failCompletion: false,
    tables: { number_quotes: [], number_orders: [], number_provisioning_profiles: [] }, ...options,
  };
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: userId, is_anonymous: false } }, error: null }) },
    from(table) {
      const filters = [];
      let insertion, update, limit = 100;
      const rows = () => table === "memberships" ? [{ organization_id: orgId, user_id: userId, role: state.role, status: "active" }]
        : table === "organizations" ? [{ id: orgId, status: "active" }] : state.tables[table] ?? [];
      const run = () => {
        if (insertion) { state.tables[table].push(...structuredClone(insertion)); return { data: null, error: null }; }
        const matching = rows().filter((row) => filters.every(([column, value]) => row[column] === value));
        if (update) matching.forEach((row) => Object.assign(row, update));
        return { data: structuredClone(matching.slice(0, limit)), error: null };
      };
      const query = {
        select: () => query, eq: (column, value) => { filters.push([column, value]); return query; },
        insert: (value) => { insertion = Array.isArray(value) ? value : [value]; return query; },
        update: (value) => { update = value; return query; }, order: () => query, limit: (value) => { limit = value; return query; },
        maybeSingle: async () => { const result = run(); return { ...result, data: result.data?.[0] ?? null }; },
        then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject),
      };
      return query;
    },
    async rpc(name, params) {
      if (name === "begin_number_order") {
        const existing = state.tables.number_orders.find((order) => order.idempotency_key === params.p_key || order.quote_id === params.p_quote_id);
        if (existing) return { data: { created: false, order: structuredClone(existing) }, error: null };
        if (state.tables.number_orders.some((order) => order.status === "pending")) return { data: null, error: { code: "23505" } };
        const quote = state.tables.number_quotes.find((item) => item.id === params.p_quote_id);
        const order = { id: randomUUID(), quote_id: quote.id, organization_id: params.p_org_id, user_id: params.p_user_id, idempotency_key: params.p_key, phone_number: quote.phone_number, account_sid: quote.account_sid, status: "pending", line_id: null, failure_message: null, created_at: new Date().toISOString() };
        state.tables.number_orders.push(order);
        return { data: { created: true, order: structuredClone(order) }, error: null };
      }
      if (name === "complete_number_order") {
        if (state.failCompletion) return { data: null, error: { code: "XX000" } };
        const order = state.tables.number_orders.find((item) => item.id === params.p_order_id);
        order.status = "completed"; order.line_id ??= randomUUID();
        return { data: order.line_id, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  const available = [{ phoneNumber: "+12025550101", capabilities: { voice: true, sms: true }, addressRequirements: "none" }];
  const provider = {
    available: async () => available,
    price: async () => ({ monthlyPrice: state.monthlyPrice, currency: "USD" }),
    regulations: async () => state.regulations,
    bundle: async () => ({ status: "twilio-approved", regulationSid: `RN${"4".repeat(32)}` }),
    address: async () => ({ accountSid }),
    voiceApplication: async () => ({ voiceUrl: `${config.API_PUBLIC_URL}/webhooks/twilio/voice/outbound`, voiceMethod: "POST" }),
    owned: async () => state.owned,
    async purchase(input) {
      state.purchaseCalls.push(input);
      if (state.reject) throw state.reject;
      const number = { sid: `PN${"5".repeat(32)}`, accountSid, phoneNumber: input.phoneNumber, friendlyName: input.friendlyName, capabilities: { voice: true, sms: true } };
      state.owned.push(number);
      if (state.timeoutAfterPurchase) throw new Error("Network timeout");
      return number;
    },
  };
  const app = createApp({ ...config, ...(options.config ?? {}) }, { createSupabaseClient: () => client, numberProvider: provider });
  t.after(() => app.close());
  const url = `/v1/organizations/${orgId}`;
  const search = () => app.inject({ method: "GET", url: `${url}/number-offers?country=US`, headers });
  const purchase = (quoteId, key = randomUUID()) => app.inject({ method: "POST", url: `${url}/number-orders`, headers: { ...headers, "idempotency-key": key }, payload: { quoteId } });
  const orders = () => app.inject({ method: "GET", url: `${url}/number-orders`, headers });
  return { app, state, search, purchase, orders, provider };
}

test("number search and purchase require authentication and organization admin rights", async (t) => {
  const { app, state, search, purchase } = setup(t);
  assert.equal((await app.inject({ url: `/v1/organizations/${orgId}/number-offers?country=US` })).statusCode, 401);
  state.role = "member";
  assert.equal((await search()).statusCode, 403);
  assert.equal((await purchase(randomUUID())).statusCode, 403);
  assert.equal(state.purchaseCalls.length, 0);
});

test("number offers expose account pricing without provider credentials or compliance IDs", async (t) => {
  const { search } = setup(t);
  const result = await search();
  assert.equal(result.statusCode, 200);
  const offer = result.json().items[0];
  assert.equal(offer.monthlyPrice, 1.15);
  assert.equal(offer.currency, "USD");
  assert.equal(offer.phoneNumber, "+12025550101");
  assert.equal("account_sid" in offer, false);
  assert.equal("bundle_sid" in offer, false);
});

test("one confirmation purchases, configures inbound webhooks and returns the assigned line", async (t) => {
  const { state, search, purchase } = setup(t);
  const quote = (await search()).json().items[0];
  const key = randomUUID();
  const [first, duplicate] = await Promise.all([purchase(quote.quoteId, key), purchase(quote.quoteId, key)]);
  assert.equal(first.statusCode, 201);
  assert.equal(first.json().status, "completed");
  assert.match(first.json().lineId, /^[0-9a-f-]{36}$/);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(state.purchaseCalls.length, 1);
  assert.equal(state.purchaseCalls[0].voiceUrl, "https://api.example.com/webhooks/twilio/voice/inbound");
  assert.equal(state.purchaseCalls[0].smsUrl, "https://api.example.com/webhooks/twilio/messages/inbound");
  assert.equal(state.purchaseCalls[0].voiceApplicationSid, undefined);
  assert.equal((await purchase(quote.quoteId, key)).json().lineId, first.json().lineId);
  assert.equal(state.purchaseCalls.length, 1);
});

test("a timeout after Twilio purchased the number is reconciled without purchasing again", async (t) => {
  const { state, search, purchase } = setup(t, { timeoutAfterPurchase: true });
  const quote = (await search()).json().items[0];
  const key = randomUUID();
  assert.equal((await purchase(quote.quoteId, key)).json().status, "completed");
  assert.equal((await purchase(quote.quoteId, key)).json().status, "completed");
  assert.equal(state.purchaseCalls.length, 1);
});

test("database failure after purchase survives reload and recovers the original purchased number", async (t) => {
  const { state, search, purchase, orders } = setup(t, { failCompletion: true });
  const quote = (await search()).json().items[0];
  assert.equal((await purchase(quote.quoteId)).json().status, "pending");
  state.failCompletion = false;
  const recovered = (await orders()).json().items[0];
  assert.equal(recovered.status, "completed");
  assert.ok(recovered.lineId);
  assert.equal(state.purchaseCalls.length, 1);
});

test("unknown submission stays pending, blocks another order and never retries the paid POST", async (t) => {
  const { state, search, purchase } = setup(t, { reject: new Error("Disconnected") });
  const quote = (await search()).json().items[0];
  const key = randomUUID();
  assert.equal((await purchase(quote.quoteId, key)).json().status, "pending");
  assert.equal((await purchase(quote.quoteId, key)).json().status, "pending");
  const other = (await search()).json().items[0];
  assert.equal((await purchase(other.quoteId)).statusCode, 409);
  assert.equal(state.purchaseCalls.length, 1);
});

test("expired, foreign and repriced quotes cannot trigger a charge", async (t) => {
  const { state, search, purchase } = setup(t);
  const quote = (await search()).json().items[0];
  const stored = state.tables.number_quotes[0];
  stored.user_id = randomUUID();
  assert.equal((await purchase(quote.quoteId)).json().code, "quote_expired");
  stored.user_id = userId;
  stored.expires_at = "2020-01-01T00:00:00Z";
  assert.equal((await purchase(quote.quoteId)).json().code, "quote_expired");
  stored.expires_at = new Date(Date.now() + 600_000).toISOString();
  state.monthlyPrice = 2;
  assert.equal((await purchase(quote.quoteId)).json().code, "price_changed");
  assert.equal(state.purchaseCalls.length, 0);
});

test("missing country compliance profile and disabled voice block purchases before spending", async (t) => {
  const first = setup(t, { regulations: [{ sid: `RN${"4".repeat(32)}` }] });
  assert.equal((await first.search()).json().code, "number_compliance_required");
  const second = setup(t, { config: { VOICE_ENABLED: false } });
  assert.equal((await second.search()).json().code, "number_setup_required");
  assert.equal(first.state.purchaseCalls.length + second.state.purchaseCalls.length, 0);
});

test("provider rejection reports a failed order and retries do not create another charge", async (t) => {
  const { state, search, purchase } = setup(t, { reject: { status: 400, message: "contains provider secrets" } });
  const quote = (await search()).json().items[0];
  const key = randomUUID();
  const response = await purchase(quote.quoteId, key);
  assert.equal(response.json().status, "failed");
  assert.equal(response.body.includes("provider secrets"), false);
  assert.equal((await purchase(quote.quoteId, key)).json().status, "failed");
  assert.equal(state.purchaseCalls.length, 1);
});

test("recovery refuses a number owned by the account but tagged for another order", async (t) => {
  const { state, search, purchase, orders } = setup(t, { reject: new Error("Disconnected") });
  const quote = (await search()).json().items[0];
  await purchase(quote.quoteId);
  state.owned.push({ sid: `PN${"6".repeat(32)}`, accountSid, phoneNumber: quote.phoneNumber, friendlyName: "another customer", capabilities: { voice: true, sms: true } });
  assert.equal((await orders()).json().items[0].status, "pending");
});

test("server rejects a client-supplied price or missing idempotency key", async (t) => {
  const { app, search, state } = setup(t);
  const quote = (await search()).json().items[0];
  assert.equal((await app.inject({ method: "POST", url: `/v1/organizations/${orgId}/number-orders`, headers, payload: { quoteId: quote.quoteId } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: `/v1/organizations/${orgId}/number-orders`, headers: { ...headers, "idempotency-key": randomUUID() }, payload: { quoteId: quote.quoteId, monthlyPrice: 0 } })).statusCode, 400);
  assert.equal(state.purchaseCalls.length, 0);
});
