import assert from "node:assert/strict";
import test from "node:test";
import twilio from "twilio";
import { createApp } from "../dist/app.js";

const config = {
  APP_ENV: "dev",
  API_HOST: "127.0.0.1",
  API_PORT: 4100,
  API_PUBLIC_URL: "http://localhost:4100",
  WEB_PUBLIC_URL: "http://localhost:5173",
  ALLOWED_ORIGINS: "http://localhost:5173",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key",
  SUPABASE_SECRET_KEY: undefined,
  VOICE_ENABLED: false,
  SMS_ENABLED: false,
  TWILIO_ACCOUNT_SID: undefined,
  TWILIO_API_KEY_SID: undefined,
  TWILIO_API_KEY_SECRET: undefined,
  TWILIO_AUTH_TOKEN: undefined,
  TWILIO_TWIML_APP_SID: undefined,
  TWILIO_ALLOWED_DESTINATIONS: "+33",
  SMS_ALLOWED_RECIPIENTS: "",
  MAX_ACTIVE_CALL_SECONDS: 900,
  MAX_RINGING_DEVICES: 4,
  allowedOrigins: new Set(["http://localhost:5173"]),
};

test("live health endpoint is public and returns a stable response", async (t) => {
  const app = createApp(config);
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/health/live" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
});

test("ready health requires Supabase Auth and PostgREST", async (t) => {
  let databaseAvailable = false;
  const requested = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    requested.push(url);
    const available = url.endsWith("/auth/v1/health") || databaseAvailable;
    return new Response(null, { status: available ? 200 : 503 });
  });
  const app = createApp(config);
  t.after(() => app.close());

  const unavailable = await app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json().dependencies, { auth: true, database: false });

  databaseAvailable = true;
  const ready = await app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json().dependencies, { auth: true, database: true });
  assert.deepEqual(requested, [
    "https://example.supabase.co/auth/v1/health",
    "https://example.supabase.co/rest/v1/",
    "https://example.supabase.co/auth/v1/health",
    "https://example.supabase.co/rest/v1/",
  ]);
});

test("user routes reject requests without a bearer token", async (t) => {
  const app = createApp(config);
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/v1/me" });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, "unauthorized");
});

test("device voice-state changes reject requests without a bearer token", async (t) => {
  const app = createApp(config);
  t.after(() => app.close());

  const response = await app.inject({
    method: "PUT",
    url: "/v1/devices/00000000-0000-0000-0000-000000000001/voice-state",
    payload: { registered: true },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, "unauthorized");
});

test("CORS only reflects configured origins", async (t) => {
  const app = createApp(config);
  t.after(() => app.close());

  const allowed = await app.inject({ method: "OPTIONS", url: "/v1/me", headers: { origin: "http://localhost:5173" } });
  const rejected = await app.inject({ method: "OPTIONS", url: "/v1/me", headers: { origin: "https://untrusted.example" } });
  assert.equal(allowed.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.equal(rejected.headers["access-control-allow-origin"], undefined);
});

test("Twilio voice and messaging webhooks reject unsigned requests", async (t) => {
  const app = createApp(config);
  t.after(() => app.close());

  const voice = await app.inject({
    method: "POST",
    url: "/webhooks/twilio/voice/inbound",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "AccountSid=AC00000000000000000000000000000000&CallSid=CA00000000000000000000000000000000",
  });
  const sms = await app.inject({
    method: "POST",
    url: "/webhooks/twilio/messages/inbound",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "AccountSid=AC00000000000000000000000000000000&MessageSid=SM00000000000000000000000000000000",
  });

  assert.equal(voice.statusCode, 403);
  assert.equal(sms.statusCode, 403);
});

test("Twilio messaging webhook accepts a valid URL-bound signature before checking storage", async (t) => {
  const authToken = "test-webhook-auth-token";
  const accountSid = "AC00000000000000000000000000000000";
  const params = { AccountSid: accountSid, MessageSid: "SM00000000000000000000000000000000" };
  const url = "http://localhost:4100/webhooks/twilio/messages/inbound";
  const signature = twilio.getExpectedTwilioSignature(authToken, url, params);
  const app = createApp({ ...config, SMS_ENABLED: true, TWILIO_ACCOUNT_SID: accountSid, TWILIO_AUTH_TOKEN: authToken });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/webhooks/twilio/messages/inbound",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    payload: new URLSearchParams(params).toString(),
  });

  assert.equal(response.statusCode, 503);
});

function createSmsTestDependencies({ sendMessage, replayed = false, prepareError = null }) {
  const rpcCalls = [];
  const providerCalls = [];
  const statusApplications = [];
  let recordedStatus = "submitting";
  const configWithSms = {
    ...config,
    SMS_ENABLED: true,
    SUPABASE_SECRET_KEY: "test-service-key",
    TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
    TWILIO_API_KEY_SID: "SK00000000000000000000000000000000",
    TWILIO_API_KEY_SECRET: "test-twilio-api-secret",
    TWILIO_AUTH_TOKEN: "test-webhook-auth-token",
    SMS_ALLOWED_RECIPIENTS: "+33600000000",
  };
  const dependencies = {
    createSupabaseClient: (_url, key) => ({
      auth: {
        getUser: async () => ({
          data: { user: { id: "00000000-0000-4000-8000-000000000010", is_anonymous: false } },
          error: null,
        }),
      },
      rpc: async (name, args) => {
        rpcCalls.push({ key, name, args });
        if (name === "consume_api_rate_limit") return { data: true, error: null };
        if (name === "prepare_outbound_message" && prepareError) return { data: null, error: prepareError };
        if (name === "prepare_outbound_message") return {
          data: {
            messageId: "00000000-0000-4000-8000-000000000020",
            conversationId: "00000000-0000-4000-8000-000000000030",
            fromNumber: "+3220000000",
            destination: "+33600000000",
            replayed,
          },
          error: null,
        };
        if (name === "apply_message_status") {
          const duplicate = statusApplications.length > 0;
          recordedStatus = args.p_status === "delivered" ? "delivered" : recordedStatus;
          statusApplications.push({ messageId: args.p_message_id, status: recordedStatus, duplicate });
          return { data: { messageId: args.p_message_id, status: recordedStatus, duplicate }, error: null };
        }
        if (name === "update_outbound_message_result") {
          if (recordedStatus !== "delivered") recordedStatus = args.p_status;
          return { data: { messageId: args.p_message_id, status: recordedStatus }, error: null };
        }
        throw new Error(`unexpected RPC ${name}`);
      },
      from: (table) => {
        assert.equal(table, "messages");
        const query = {
          select: () => query,
          eq: () => query,
          maybeSingle: async () => ({ data: {
            id: "00000000-0000-4000-8000-000000000020",
            conversation_id: "00000000-0000-4000-8000-000000000030",
            status: "submitting",
            provider_message_sid: "SM00000000000000000000000000000001",
            created_at: "2026-09-25T10:00:00.000Z",
          }, error: null }),
        };
        return query;
      },
    }),
    createSmsProvider: (apiKeySid, apiKeySecret, accountSid) => {
      assert.equal(apiKeySid, configWithSms.TWILIO_API_KEY_SID);
      assert.equal(apiKeySecret, configWithSms.TWILIO_API_KEY_SECRET);
      assert.equal(accountSid, configWithSms.TWILIO_ACCOUNT_SID);
      return { messages: { create: async (input) => {
        providerCalls.push(input);
        return sendMessage(input);
      } } };
    },
  };
  return { configWithSms, dependencies, providerCalls, rpcCalls, statusApplications };
}

function sendSmsRequest(app, body = " Bonjour 🌍 ", idempotencyKey = "sms-test-action-0001", destination = "+33600000000") {
  return app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { authorization: "Bearer test-user-token", "idempotency-key": idempotencyKey },
    payload: {
      organizationId: "00000000-0000-4000-8000-000000000001",
      lineId: "00000000-0000-4000-8000-000000000002",
      destination,
      body,
    },
  });
}

test("outbound SMS contract passes the normalized message to a mocked provider", async (t) => {
  const mocked = createSmsTestDependencies({ sendMessage: async () => ({
    sid: "SM00000000000000000000000000000001",
    status: "queued",
  }) });
  const app = createApp(mocked.configWithSms, mocked.dependencies);
  t.after(() => app.close());

  const response = await sendSmsRequest(app);
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json(), {
    id: "00000000-0000-4000-8000-000000000020",
    conversationId: "00000000-0000-4000-8000-000000000030",
    status: "submitting",
    submissionConfirmed: true,
  });
  assert.deepEqual(mocked.providerCalls, [{
    from: "+3220000000",
    to: "+33600000000",
    body: "Bonjour 🌍",
    statusCallback: "http://localhost:4100/webhooks/twilio/messages/status?messageId=00000000-0000-4000-8000-000000000020",
  }]);
  assert.equal(mocked.rpcCalls.find((call) => call.name === "prepare_outbound_message").args.p_idempotency_key, "sms-test-action-0001");
  assert.equal(mocked.rpcCalls.find((call) => call.name === "update_outbound_message_result").args.p_message_sid, "SM00000000000000000000000000000001");
});

test("outbound SMS preserves French accents, emoji, long bodies, and rapid separate actions", async (t) => {
  const mocked = createSmsTestDependencies({ sendMessage: async (_input) => ({
    sid: "SM00000000000000000000000000000001",
    status: "queued",
  }) });
  const app = createApp(mocked.configWithSms, mocked.dependencies);
  t.after(() => app.close());

  const bodies = [
    { input: "  Déjà reçu, à bientôt !  ", expected: "Déjà reçu, à bientôt !" },
    { input: "  Salut 🙂  ", expected: "Salut 🙂" },
    { input: "é".repeat(161), expected: "é".repeat(161) },
    { input: "🙂".repeat(71), expected: "🙂".repeat(71) },
  ];

  for (const [index, body] of bodies.entries()) {
    const response = await sendSmsRequest(app, body.input, `sms-burst-test-${index}`);
    assert.equal(response.statusCode, 201);
  }
  assert.deepEqual(mocked.providerCalls.map(({ body }) => body), bodies.map(({ expected }) => expected));
  assert.equal(mocked.providerCalls.length, bodies.length);
});

test("outbound SMS contract returns a definite provider refusal without retrying", async (t) => {
  const mocked = createSmsTestDependencies({ sendMessage: async () => {
    throw Object.assign(new Error("recipient rejected"), { status: 400, code: 21211 });
  } });
  const app = createApp(mocked.configWithSms, mocked.dependencies);
  t.after(() => app.close());

  const response = await sendSmsRequest(app);
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().code, "message_failed");
  assert.equal(response.json().status, "failed");
  assert.equal(typeof response.json().requestId, "string");
  assert.equal(mocked.providerCalls.length, 1);
  const result = mocked.rpcCalls.find((call) => call.name === "update_outbound_message_result");
  assert.equal(result.args.p_message_sid, null);
  assert.equal(result.args.p_status, "failed");
});

test("outbound SMS contract preserves an uncertain provider timeout for reconciliation", async (t) => {
  const mocked = createSmsTestDependencies({ sendMessage: async () => {
    throw Object.assign(new Error("socket timed out after submission"), { name: "TimeoutError" });
  } });
  const app = createApp(mocked.configWithSms, mocked.dependencies);
  t.after(() => app.close());

  const response = await sendSmsRequest(app);
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().status, "unknown");
  assert.equal(mocked.providerCalls.length, 1);
  const result = mocked.rpcCalls.find((call) => call.name === "update_outbound_message_result");
  assert.equal(result.args.p_message_sid, null);
  assert.equal(result.args.p_status, "unknown");
});

test("outbound SMS refuses a line rejected by the authorization RPC", async (t) => {
  const mocked = createSmsTestDependencies({
    prepareError: { code: "42501" },
    sendMessage: async () => { throw new Error("unauthorized line must not reach Twilio"); },
  });
  const app = createApp(mocked.configWithSms, mocked.dependencies);
  t.after(() => app.close());

  const response = await sendSmsRequest(app);
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().code, "message_forbidden");
  assert.equal(mocked.providerCalls.length, 0);
});

test("outbound SMS refuses an unlisted number even when its country is allowed", async (t) => {
  const mocked = createSmsTestDependencies({ sendMessage: async () => {
    throw new Error("an unlisted recipient must not reach Twilio");
  } });
  const app = createApp(mocked.configWithSms, mocked.dependencies);
  t.after(() => app.close());

  const response = await sendSmsRequest(app, "Bonjour", "sms-unlisted-recipient-001", "+33600000001");
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().code, "destination_not_allowed");
  assert.equal(mocked.rpcCalls.some((call) => call.name === "prepare_outbound_message"), false);
  assert.equal(mocked.providerCalls.length, 0);
});

test("outbound SMS refuses destinations outside the configured country prefixes", async (t) => {
  const mocked = createSmsTestDependencies({ sendMessage: async () => {
    throw new Error("a destination outside the country allowlist must not reach Twilio");
  } });
  const app = createApp({ ...mocked.configWithSms, TWILIO_ALLOWED_DESTINATIONS: "+32" }, mocked.dependencies);
  t.after(() => app.close());

  const response = await sendSmsRequest(app);
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().code, "destination_not_allowed");
  assert.equal(mocked.rpcCalls.some((call) => call.name === "prepare_outbound_message"), false);
  assert.equal(mocked.providerCalls.length, 0);
});

test("replaying the same outbound SMS action does not call the provider again", async (t) => {
  const mocked = createSmsTestDependencies({ replayed: true, sendMessage: async () => {
    throw new Error("a replay must not reach the provider");
  } });
  const app = createApp(mocked.configWithSms, mocked.dependencies);
  t.after(() => app.close());

  const response = await sendSmsRequest(app);
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().replayed, true);
  assert.equal(response.json().submissionConfirmed, true);
  assert.equal(mocked.providerCalls.length, 0);
  assert.equal(mocked.rpcCalls.filter((call) => call.name === "prepare_outbound_message").length, 1);
});

test("a delivery callback received before the provider response is not regressed to submitting", async (t) => {
  let app;
  const mocked = createSmsTestDependencies({ sendMessage: async () => {
    const params = {
      AccountSid: "AC00000000000000000000000000000000",
      MessageSid: "SM00000000000000000000000000000001",
      MessageStatus: "delivered",
    };
    const url = "http://localhost:4100/webhooks/twilio/messages/status?messageId=00000000-0000-4000-8000-000000000020";
    const signature = twilio.getExpectedTwilioSignature("test-webhook-auth-token", url, params);
    const callback = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/messages/status?messageId=00000000-0000-4000-8000-000000000020",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
      payload: new URLSearchParams(params).toString(),
    });
    assert.equal(callback.statusCode, 204);
    return { sid: params.MessageSid, status: "queued" };
  } });
  app = createApp(mocked.configWithSms, mocked.dependencies);
  t.after(() => app.close());

  const response = await sendSmsRequest(app);
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().status, "delivered");
  const rpcNames = mocked.rpcCalls.map((call) => call.name);
  assert.ok(rpcNames.indexOf("apply_message_status") < rpcNames.indexOf("update_outbound_message_result"));
});

test("duplicate signed delivery callbacks are acknowledged and applied idempotently", async (t) => {
  const mocked = createSmsTestDependencies({ sendMessage: async () => ({
    sid: "SM00000000000000000000000000000001",
    status: "queued",
  }) });
  const app = createApp(mocked.configWithSms, mocked.dependencies);
  t.after(() => app.close());

  const submitted = await sendSmsRequest(app);
  assert.equal(submitted.statusCode, 201);
  const params = {
    AccountSid: mocked.configWithSms.TWILIO_ACCOUNT_SID,
    MessageSid: "SM00000000000000000000000000000001",
    MessageStatus: "delivered",
  };
  const url = "http://localhost:4100/webhooks/twilio/messages/status?messageId=00000000-0000-4000-8000-000000000020";
  const signature = twilio.getExpectedTwilioSignature(mocked.configWithSms.TWILIO_AUTH_TOKEN, url, params);
  const callbackRequest = () => app.inject({
    method: "POST",
    url: "/webhooks/twilio/messages/status?messageId=00000000-0000-4000-8000-000000000020",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    payload: new URLSearchParams(params).toString(),
  });

  const first = await callbackRequest();
  const duplicate = await callbackRequest();
  assert.equal(first.statusCode, 204);
  assert.equal(duplicate.statusCode, 204);
  assert.deepEqual(mocked.statusApplications.map((result) => result.duplicate), [false, true]);
});
