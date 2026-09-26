import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { serviceStatus } from "../dist/services.js";

const base = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "publishable-test" };
const enabled = { ...base, SUPABASE_SECRET_KEY: "private-test", VOICE_ENABLED: "true", SMS_ENABLED: "true", SMS_ALLOWED_RECIPIENTS: "+33100000001", TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000001", TWILIO_API_KEY_SID: "key", TWILIO_API_KEY_SECRET: "secret", TWILIO_AUTH_TOKEN: "token", TWILIO_TWIML_APP_SID: "app", API_PUBLIC_URL: "https://api.example.test" };
test("unconfigured services never advertise calls, SMS, administration or purchases", () => {
  assert.deepEqual(serviceStatus(loadConfig(base)), { voiceEnabled: false, smsEnabled: false, administrationEnabled: false, numberPurchaseEnabled: false, operationsPaused: false, pauseMessage: null });
});
test("maintenance pauses paid actions without disabling inbound voice registration", () => {
  const status = serviceStatus(loadConfig({ ...enabled, OPERATIONS_PAUSED: "true" }));
  assert.equal(status.voiceEnabled, true); assert.equal(status.smsEnabled, true);
  assert.equal(status.operationsPaused, true); assert.equal(status.numberPurchaseEnabled, false);
  assert.ok(status.pauseMessage);
});
test("purchases require HTTPS callbacks even when voice is configured", () => {
  assert.equal(serviceStatus(loadConfig(enabled)).numberPurchaseEnabled, true);
  assert.equal(serviceStatus(loadConfig({ ...enabled, API_PUBLIC_URL: "http://localhost:4100" })).numberPurchaseEnabled, false);
});
test("service status is authenticated and exposes no credential values", async t => {
  const app = createApp(loadConfig(enabled), { createSupabaseClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "user", is_anonymous: false } }, error: null }) } }) });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: "GET", url: "/v1/services" })).statusCode, 401);
  const result = await app.inject({ method: "GET", url: "/v1/services", headers: { authorization: "Bearer session" } });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(Object.keys(result.json()).sort(), ["administrationEnabled", "numberPurchaseEnabled", "operationsPaused", "pauseMessage", "smsEnabled", "voiceEnabled"]);
});
