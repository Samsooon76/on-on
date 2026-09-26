import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { createApp } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { buildApiSpec } from "../dist/api-documentation.js";
import {
  isPublicAddress,
  resolveWebhookTarget,
  encryptWebhookSecret,
  decryptWebhookSecret,
  webhookSignature,
  deliverCustomerWebhookBatch,
} from "../dist/customer-webhook-delivery.js";

const config = loadConfig({
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key",
  SUPABASE_SECRET_KEY: "test-service",
  WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
});
const org = "10000000-0000-4000-8000-000000000001",
  user = "00000000-0000-4000-8000-000000000001",
  id = "20000000-0000-4000-8000-000000000001";
const row = {
  id,
  organization_id: org,
  description: "CRM",
  url: "https://example.com/hooks",
  events: ["sms.received"],
  enabled: true,
  created_at: "2026-09-26T10:00:00Z",
  secret_ciphertext: "never-send-me",
};
function fixture(t, { role = "admin", active = true } = {}) {
  const queries = [],
    calls = [];
  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: user } }, error: null }),
    },
    from(table) {
      const log = { table, filters: [] };
      queries.push(log);
      const query = {
        select(columns) {
          log.columns = columns;
          return query;
        },
        eq(k, v) {
          log.filters.push([k, v]);
          return query;
        },
        is(k, v) {
          log.filters.push([k, v]);
          return query;
        },
        in() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        async maybeSingle() {
          return {
            data:
              table === "memberships"
                ? { role }
                : table === "organizations"
                  ? active
                    ? { id: org }
                    : null
                  : { id },
            error: null,
          };
        },
        then(resolve, reject) {
          return Promise.resolve({
            data: table === "webhook_endpoints" ? [row] : [],
            error: null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      return {
        data:
          args.p_action === "enabled"
            ? { ...row, enabled: args.p_input.enabled }
            : args.p_action === "test" || args.p_action === "replay"
              ? { eventId: id }
              : row,
        error: null,
      };
    },
  };
  const app = createApp(config, { createSupabaseClient: () => client });
  t.after(() => app.close());
  return {
    app,
    queries,
    calls,
    headers: { authorization: "Bearer test-session" },
  };
}
test("public documentation and OpenAPI work without a session, with accurate body contracts", async (t) => {
  const app = createApp(config);
  t.after(() => app.close());
  const page = await app.inject("/docs");
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /API &amp; webhooks|API & webhooks/);
  assert.match(
    page.headers["content-security-policy"],
    /frame-ancestors 'none'/,
  );
  const response = await app.inject("/openapi.json");
  assert.equal(response.statusCode, 200);
  const spec = response.json();
  assert.equal(spec.openapi, "3.1.0");
  const sms = spec.paths["/v1/messages"].post;
  assert.ok(
    sms.parameters.some((p) => p.name === "Idempotency-Key" && p.required),
  );
  assert.deepEqual(
    sms.requestBody.content["application/json"].schema.required,
    ["organizationId", "lineId", "destination", "body"],
  );
  assert.ok(spec.paths["/v1/contacts/{id}"].delete.responses["204"]);
  assert.ok(spec.webhooks.customerEvent.post);
  assert.ok(!JSON.stringify(spec).includes("test-service"));
  assert.ok(!JSON.stringify(spec).includes("webhooks/twilio"));
  // Every documented route is actually registered (401 proves the auth hook runs).
  for (const [path, operations] of Object.entries(spec.paths))
    for (const method of Object.keys(operations)) {
      const response = await app.inject({
        method: method.toUpperCase(),
        url: path.replace(/\{[^}]+\}/g, id),
      });
      assert.notEqual(response.statusCode, 404, `${method} ${path}`);
    }
  assert.equal(
    Object.keys(buildApiSpec("https://example.com/").paths).length,
    Object.keys(spec.paths).length,
  );
});
test("webhooks require an authenticated active administrator", async (t) => {
  for (const scope of [{ role: "member" }, { active: false }]) {
    const { app, headers } = fixture(t, scope);
    assert.equal(
      (await app.inject({ url: `/v1/organizations/${org}/webhooks`, headers }))
        .statusCode,
      403,
    );
  }
  const { app } = fixture(t);
  assert.equal(
    (await app.inject(`/v1/organizations/${org}/webhooks`)).statusCode,
    401,
  );
});
test("listing scopes to tenant and never serializes signing material", async (t) => {
  const { app, headers, queries } = fixture(t);
  const response = await app.inject({
    url: `/v1/organizations/${org}/webhooks`,
    headers,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items[0].id, id);
  assert.ok(!response.body.includes("never-send-me"));
  assert.ok(
    queries
      .find((q) => q.table === "webhook_endpoints")
      .filters.some(
        ([key, value]) => key === "organization_id" && value === org,
      ),
  );
});
test("mutations bind actor and organization, validate UUIDs, and return accepted test IDs", async (t) => {
  const { app, headers, calls } = fixture(t),
    url = `/v1/organizations/${org}/webhooks/${id}`;
  const patch = await app.inject({
    method: "PATCH",
    url,
    headers,
    payload: { enabled: false },
  });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().enabled, false);
  assert.equal(calls[0].args.p_actor, user);
  assert.equal(calls[0].args.p_org, org);
  const test = await app.inject({
    method: "POST",
    url: url + "/test",
    headers,
  });
  assert.equal(test.statusCode, 202);
  assert.equal(test.json().eventId, id);
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url,
        headers,
        payload: { enabled: "yes" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/v1/organizations/${org}/webhooks/bad/test`,
        headers,
      })
    ).statusCode,
    400,
  );
  const rotate = await app.inject({
    method: "POST",
    url: url + "/rotate-secret",
    headers,
  });
  assert.equal(rotate.statusCode, 200);
  assert.equal(rotate.headers["cache-control"], "no-store");
  assert.match(rotate.json().secret, /^whsec_/);
  assert.equal(
    (await app.inject({ method: "DELETE", url, headers })).statusCode,
    204,
  );
});
test("HTTP rejects private destination URLs and missing encryption setup", async (t) => {
  const { app, headers } = fixture(t);
  for (const url of [
    "http://example.com/hook",
    "https://127.0.0.1/hook",
    "https://[::1]/hook",
    "https://user:pass@example.com/hook",
  ])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/v1/organizations/${org}/webhooks`,
          headers,
          payload: { description: "Test", url, events: ["sms.received"] },
        })
      ).statusCode,
      400,
    );
  const disabled = createApp(
    { ...config, WEBHOOK_ENCRYPTION_KEY: undefined },
    {
      createSupabaseClient: () => ({
        auth: {
          getUser: async () => ({ data: { user: { id: user } }, error: null }),
        },
      }),
    },
  );
  t.after(() => disabled.close());
  assert.equal(
    (
      await disabled.inject({
        url: `/v1/organizations/${org}/webhooks`,
        headers,
      })
    ).statusCode,
    503,
  );
});
test("destination validation blocks internal, mapped, multicast and mixed DNS addresses", async () => {
  for (const value of [
    "127.0.0.1",
    "10.2.3.4",
    "169.254.169.254",
    "172.31.1.1",
    "192.168.1.2",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2002:7f00:1::",
    "2001:db8::1",
  ])
    assert.equal(isPublicAddress(value), false, value);
  for (const value of [
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])
    assert.equal(isPublicAddress(value), true, value);
  const resolver = async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "10.0.0.1", family: 4 },
  ];
  await assert.rejects(
    resolveWebhookTarget("https://example.com/hook", resolver),
    /unsafe_address/,
  );
  const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }];
  const target = await resolveWebhookTarget(
    "https://example.com/hook",
    publicResolver,
  );
  assert.equal(target.address.address, "8.8.8.8");
  assert.equal(target.url.hostname, "example.com");
});
test("signatures bind timestamp and raw bytes; ciphertext authenticates and hides secret", () => {
  const key = config.WEBHOOK_ENCRYPTION_KEY,
    secret = "whsec_testing",
    body = '{"body":"bonjour é"}',
    timestamp = "1790400000";
  const encrypted = encryptWebhookSecret(secret, key);
  assert.ok(!encrypted.includes(secret));
  assert.equal(decryptWebhookSecret(encrypted, key), secret);
  assert.throws(() =>
    decryptWebhookSecret(encrypted, Buffer.alloc(32, 8).toString("base64")),
  );
  const expected = createHmac("sha256", secret)
    .update(timestamp + "." + body)
    .digest("hex");
  assert.equal(
    webhookSignature(secret, timestamp, body),
    `t=${timestamp},v1=${expected}`,
  );
  assert.notEqual(
    webhookSignature(secret, timestamp, body + " "),
    webhookSignature(secret, timestamp, body),
  );
});
test("worker records successes and failures with lease tokens and sanitized errors", async () => {
  const jobs = [200, 302, "error"].map((result, index) => ({
    id: `job-${index}`,
    leaseToken: `lease-${index}`,
    attempt: 1,
    url: "https://example.com",
    secretCiphertext: "encrypted",
    payload: { id: `event-${index}` },
    result,
  }));
  const finished = [];
  const store = {
    rpc: async (name, args) =>
      name === "claim_customer_webhooks"
        ? { data: jobs, error: null }
        : (finished.push(args), { data: true, error: null }),
  };
  const count = await deliverCustomerWebhookBatch(store, "key", async (job) => {
    if (job.result === "error") throw new Error("sensitive endpoint token");
    return job.result;
  });
  assert.equal(count, 3);
  assert.equal(finished[0].p_lease, "lease-0");
  assert.equal(finished[0].p_error, null);
  assert.equal(finished[1].p_error, "http_302");
  assert.equal(finished[2].p_error, "delivery_failed");
});

test("customer verification example rejects stale, future, forged and reformatted requests", async () => {
  const { verifySignature } = await import(
    "../../../examples/webhooks/verify-signature.mjs"
  );
  const raw = Buffer.from('{"body":"é"}'),
    secret = "whsec_testing",
    time = 1790400000;
  const signature = webhookSignature(secret, String(time), raw.toString());
  assert.equal(verifySignature(raw, signature, secret, time), true);
  assert.equal(verifySignature(raw, signature, secret, time + 301), false);
  assert.equal(verifySignature(raw, signature, secret, time - 301), false);
  assert.equal(verifySignature(raw, signature, "whsec_wrong", time), false);
  assert.equal(
    verifySignature(Buffer.from('{ "body":"é"}'), signature, secret, time),
    false,
  );
  assert.equal(verifySignature(raw, "t=oops,v1=xyz", secret, time), false);
});
