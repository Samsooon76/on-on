import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import RequestClient from "twilio/lib/base/RequestClient.js";
import { createApp } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { createNumberProvider } from "../dist/number-provisioning.js";

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
    role: "admin", monthlyPrice: 1.15, purchaseCalls: [], completionCalls: [], owned: [], regulations: [], failCompletion: false,
    available: [{ phoneNumber: "+33523550534", capabilities: { voice: true, sms: false }, addressRequirements: "none" }],
    bundle: { status: "twilio-approved", regulationSid: `RN${"4".repeat(32)}` },
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
        state.completionCalls.push(params);
        if (state.failCompletion) return { data: null, error: { code: "XX000" } };
        const order = state.tables.number_orders.find((item) => item.id === params.p_order_id);
        order.status = "completed"; order.line_id ??= randomUUID();
        return { data: order.line_id, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  const provider = {
    available: async () => state.available,
    price: async () => ({ monthlyPrice: state.monthlyPrice, currency: "USD" }),
    regulations: async () => state.regulations,
    bundle: async () => state.bundle,
    address: async () => ({ accountSid }),
    voiceApplication: async () => ({ voiceUrl: `${config.API_PUBLIC_URL}/webhooks/twilio/voice/outbound`, voiceMethod: "POST" }),
    owned: async () => state.owned,
    async purchase(input) {
      state.purchaseCalls.push(input);
      if (state.reject) throw state.reject;
      const number = { sid: `PN${"5".repeat(32)}`, accountSid, phoneNumber: input.phoneNumber, friendlyName: input.friendlyName, capabilities: state.available.find((item) => item.phoneNumber === input.phoneNumber).capabilities };
      state.owned.push(number);
      if (state.timeoutAfterPurchase) throw new Error("Network timeout");
      return number;
    },
  };
  const app = createApp({ ...config, ...(options.config ?? {}) }, { createSupabaseClient: () => client, numberProvider: provider });
  t.after(() => app.close());
  const url = `/v1/organizations/${orgId}`;
  const search = (country = "FR") => app.inject({ method: "GET", url: `${url}/number-offers?country=${country}`, headers });
  const purchase = (quoteId, key = randomUUID()) => app.inject({ method: "POST", url: `${url}/number-orders`, headers: { ...headers, "idempotency-key": key }, payload: { quoteId } });
  const orders = () => app.inject({ method: "GET", url: `${url}/number-orders`, headers });
  return { app, state, search, purchase, orders, provider };
}

test("Twilio searches local voice inventory without requiring SMS or MMS, including purchase revalidation", async (t) => {
  const requests = [];
  t.mock.method(RequestClient.prototype, "request", async function (input) {
    requests.push(input);
    assert.equal(this.autoRetry, false);
    return { statusCode: 200, body: { available_phone_numbers: [], next_page_uri: null } };
  });
  const provider = createNumberProvider(config);
  await provider.available("FR");
  await provider.available("FR", "+33523550534");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.method, "get");
    assert.match(request.uri, /\/AvailablePhoneNumbers\/FR\/Local.json$/);
    assert.equal(request.params.VoiceEnabled, "true");
    assert.equal(request.params.SmsEnabled, undefined);
    assert.equal(request.params.MmsEnabled, undefined);
  }
  assert.equal(requests[1].params.Contains, "+33523550534");
});

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
  assert.equal(offer.phoneNumber, "+33523550534");
  assert.equal(offer.smsEnabled, false);
  assert.equal("account_sid" in offer, false);
  assert.equal("bundle_sid" in offer, false);
});

test("one confirmation buys a voice-only number, configures voice webhooks and returns the assigned line", async (t) => {
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
  assert.equal(state.purchaseCalls[0].smsUrl, undefined);
  assert.equal(state.purchaseCalls[0].smsMethod, undefined);
  assert.equal(state.purchaseCalls[0].statusCallback, "https://api.example.com/webhooks/twilio/voice/status");
  assert.equal(state.completionCalls[0].p_voice, true);
  assert.equal(state.completionCalls[0].p_sms, false);
  assert.equal(state.purchaseCalls[0].voiceApplicationSid, undefined);
  assert.equal((await purchase(quote.quoteId, key)).json().lineId, first.json().lineId);
  assert.equal(state.purchaseCalls.length, 1);
});

test("SMS-capable local numbers are offered and assigned for voice only, including recovery", async (t) => {
  const { state, search, purchase, orders } = setup(t, { failCompletion: true });
  state.available[0].capabilities.sms = true;
  const quote = (await search()).json().items[0];
  assert.equal(quote.smsEnabled, false);
  assert.equal(state.tables.number_quotes[0].sms_enabled, false);
  assert.equal((await purchase(quote.quoteId)).json().status, "pending");
  state.failCompletion = false;
  assert.equal((await orders()).json().items[0].status, "completed");
  assert.ok(state.completionCalls.length >= 2);
  assert.ok(state.completionCalls.every((input) => input.p_voice && input.p_sms === false));
  assert.equal(state.purchaseCalls.length, 1);
  assert.equal(state.purchaseCalls[0].smsUrl, undefined);
});

test("numbers without voice are excluded and a loss of voice availability prevents charging", async (t) => {
  const { state, search, purchase } = setup(t);
  const quote = (await search()).json().items[0];
  state.available[0].capabilities.voice = false;
  assert.equal((await purchase(quote.quoteId)).json().code, "number_unavailable");
  const response = await search();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().items, []);
  assert.equal(state.purchaseCalls.length, 0);
});

test("French local voice-only purchase supplies the approved local bundle and required address", async (t) => {
  const { state, search, purchase } = setup(t, { regulations: [{ sid: `RN${"4".repeat(32)}` }] });
  const profile = { organization_id: orgId, country: "FR", end_user_type: "business", bundle_sid: `BU${"6".repeat(32)}`, address_sid: `AD${"7".repeat(32)}` };
  state.tables.number_provisioning_profiles.push(profile);
  state.available[0].addressRequirements = "local";
  const offers = await search();
  assert.equal(offers.statusCode, 200);
  const result = await purchase(offers.json().items[0].quoteId);
  assert.equal(result.statusCode, 201);
  assert.equal(state.purchaseCalls[0].bundleSid, profile.bundle_sid);
  assert.equal(state.purchaseCalls[0].addressSid, profile.address_sid);
  assert.equal(state.purchaseCalls[0].smsUrl, undefined);
  assert.equal(state.completionCalls[0].p_sms, false);
});

test("unapproved or wrong-type bundles and missing addresses still block a local voice purchase", async (t) => {
  const { state, search, purchase } = setup(t, { regulations: [{ sid: `RN${"4".repeat(32)}` }] });
  const profile = { organization_id: orgId, country: "FR", end_user_type: "business", bundle_sid: `BU${"6".repeat(32)}`, address_sid: `AD${"7".repeat(32)}` };
  state.tables.number_provisioning_profiles.push(profile);
  const quote = (await search()).json().items[0];
  state.bundle.status = "pending-review";
  assert.equal((await purchase(quote.quoteId)).json().code, "number_compliance_required");
  assert.match((await search()).json().message, /pas encore approuvé/);
  state.bundle.status = "twilio-approved";
  state.bundle.regulationSid = `RN${"8".repeat(32)}`;
  assert.equal((await purchase(quote.quoteId)).json().code, "number_compliance_required");
  assert.match((await search()).json().message, /ne correspond pas aux numéros locaux/);
  state.bundle.regulationSid = `RN${"4".repeat(32)}`;
  state.available[0].addressRequirements = "local";
  profile.address_sid = null;
  assert.equal((await search()).json().code, "number_address_required");
  assert.equal(state.purchaseCalls.length, 0);
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
