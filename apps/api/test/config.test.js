import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../dist/config.js";

const base = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key",
};

test("API uses Railway PORT when API_PORT is not set", () => {
  assert.equal(loadConfig({ ...base, PORT: "8080" }).API_PORT, 8080);
});

test("explicit API_PORT takes precedence over PORT", () => {
  assert.equal(loadConfig({ ...base, API_PORT: "4100", PORT: "8080" }).API_PORT, 4100);
});

test("customer webhooks reject malformed encryption keys and missing server credentials", () => {
  assert.throws(() => loadConfig({ ...base, WEBHOOK_ENCRYPTION_KEY: "not-a-key" }));
  assert.throws(() => loadConfig({ ...base, WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") }));
  assert.equal(loadConfig({ ...base, SUPABASE_SECRET_KEY: "server-test-key", WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") }).WEBHOOK_ENCRYPTION_KEY.length, 44);
});
