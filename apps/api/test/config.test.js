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
