import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "../dist/index.js";

const client = body => createApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => "test", fetcher: async () => body() });
test("an HTTP 200 with HTML or invalid JSON is never accepted as a successful write", async () => {
  for (const body of ["<html>Deployment unavailable</html>", "", "null", "{broken"]) {
    await assert.rejects(client(() => new Response(body)).request("/contact", { method: "POST", body: "{}" }), { code: "invalid_api_response", status: 502 });
  }
});
test("204 deletion responses remain valid but empty list responses are rejected", async () => {
  assert.equal(await client(() => new Response(null, { status: 204 })).request("/contact", { method: "DELETE" }), null);
  await assert.rejects(client(() => new Response(null, { status: 204 })).getPage("/contacts"), { code: "invalid_api_response" });
});
test("a stable client uses the current token for later requests", async () => {
  let token = "first"; const observed = [];
  const api = createApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => token, fetcher: async (_, init) => { observed.push(init.headers.get("authorization")); return Response.json({ ok: true }); } });
  await api.request("/token"); token = "renewed"; await api.request("/token");
  assert.deepEqual(observed, ["Bearer first", "Bearer renewed"]);
});
