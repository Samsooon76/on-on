import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { createApp } from "../dist/app.js";

const userId = "00000000-0000-4000-8000-000000000010";
const config = {
  APP_ENV: "dev", API_HOST: "127.0.0.1", API_PORT: 4100, API_PUBLIC_URL: "http://localhost:4100", WEB_PUBLIC_URL: "http://localhost:5173",
  ALLOWED_ORIGINS: "http://localhost:5173", SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key",
  SUPABASE_SECRET_KEY: undefined, VOICE_ENABLED: false, SMS_ENABLED: false, TWILIO_ACCOUNT_SID: undefined, TWILIO_API_KEY_SID: undefined,
  TWILIO_API_KEY_SECRET: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_TWIML_APP_SID: undefined, TWILIO_ALLOWED_DESTINATIONS: "+33",
  SMS_ALLOWED_RECIPIENTS: "", MAX_ACTIVE_CALL_SECONDS: 900, MAX_RINGING_DEVICES: 4, allowedOrigins: new Set(["http://localhost:5173"]),
};

// A real ES256 signing key, like the one the hosted project publishes in its JWKS.
async function createSigner() {
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const kid = crypto.randomUUID();
  const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid, alg: "ES256", use: "sig", key_ops: ["verify"] };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = (overrides = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return { sub: userId, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600, is_anonymous: false, session_id: crypto.randomUUID(), ...overrides };
  };
  async function sign(payload = claims()) {
    const signingInput = `${encode({ alg: "ES256", typ: "JWT", kid })}.${encode(payload)}`;
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, Buffer.from(signingInput));
    return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
  }
  return { jwk, sign, claims };
}

// Every network call the API makes to Supabase goes through this recorder.
function createBackend({ jwk, jwksStatus = 200, userStatus = 200 }) {
  const requests = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    requests.push(`${init.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname === "/auth/v1/.well-known/jwks.json") return jwksStatus === 200 ? Response.json({ keys: [jwk] }) : Response.json({ msg: "unavailable" }, { status: jwksStatus });
    if (url.pathname === "/auth/v1/user") {
      return userStatus === 200
        ? Response.json({ id: userId, aud: "authenticated", role: "authenticated", is_anonymous: false })
        : Response.json({ code: userStatus, error_code: "bad_jwt", msg: "invalid token" }, { status: userStatus });
    }
    if (url.pathname.startsWith("/rest/v1/")) return Response.json([]);
    return Response.json({}, { status: 404 });
  };
  const dependencies = { createSupabaseClient: (url, key, options) => createClient(url, key, { ...options, global: { ...options?.global, fetch } }) };
  const count = (needle) => requests.filter((request) => request.includes(needle)).length;
  return { requests, dependencies, jwksFetches: () => count("jwks.json"), userChecks: () => count("/auth/v1/user"), count };
}

async function request(app, token, { method = "GET", url = "/v1/services", payload } = {}) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
}

test("a signed-in read is verified locally without calling Supabase Auth", async (t) => {
  const signer = await createSigner();
  const backend = createBackend({ jwk: signer.jwk });
  const app = createApp(config, backend.dependencies);
  t.after(() => app.close());
  const token = await signer.sign();

  const first = await request(app, token, { url: "/v1/organizations" });
  const second = await request(app, token, { url: "/v1/organizations" });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(backend.userChecks(), 0, "no per-request Auth round trip");
  assert.equal(backend.jwksFetches(), 1, "signing keys are fetched once, then cached");
  assert.ok(backend.requests.some((entry) => entry.includes("/rest/v1/memberships") && entry.includes(`user_id=eq.${userId}`)), "queries run as the user named by the token");
});

test("tokens with a bad signature, expiry, role, audience, subject or anonymous flag are refused without asking Auth", async (t) => {
  const signer = await createSigner();
  const backend = createBackend({ jwk: signer.jwk });
  const app = createApp(config, backend.dependencies);
  t.after(() => app.close());
  const valid = await signer.sign();
  const [header, payload] = valid.split(".");
  const now = Math.floor(Date.now() / 1000);
  const refused = {
    "tampered signature": `${header}.${payload}.${Buffer.alloc(64, 1).toString("base64url")}`,
    "forged payload": `${header}.${Buffer.from(JSON.stringify({ ...signer.claims(), sub: "00000000-0000-4000-8000-0000000000ff" })).toString("base64url")}.${valid.split(".")[2]}`,
    "expired": await signer.sign(signer.claims({ iat: now - 7200, exp: now - 3600 })),
    "anonymous role": await signer.sign(signer.claims({ role: "anon" })),
    "wrong audience": await signer.sign(signer.claims({ aud: "https://example.test/mcp" })),
    "missing subject": await signer.sign(signer.claims({ sub: undefined })),
    "non-UUID subject": await signer.sign(signer.claims({ sub: "someone" })),
    "anonymous sign-in": await signer.sign(signer.claims({ is_anonymous: true })),
    "not a JWT": "not-a-real-token",
  };

  for (const [name, token] of Object.entries(refused)) {
    const response = await request(app, token);
    assert.equal(response.statusCode, 401, name);
    assert.equal(response.json().code, "unauthorized", name);
  }
  assert.equal(backend.userChecks(), 0, "definitive refusals never reach Auth");
  assert.equal((await request(app, valid)).statusCode, 200, "the untouched token still works");
});

test("legacy symmetric tokens and unreachable signing keys fall back to the Auth check", async (t) => {
  const signer = await createSigner();
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const legacy = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(signer.claims({ exp: now + 3600 }))}.${Buffer.alloc(32, 7).toString("base64url")}`;

  const accepted = createBackend({ jwk: signer.jwk });
  const legacyApp = createApp(config, accepted.dependencies);
  t.after(() => legacyApp.close());
  assert.equal((await request(legacyApp, legacy)).statusCode, 200);
  assert.equal(accepted.userChecks(), 1, "the authoritative check decides for legacy tokens");

  const outage = createBackend({ jwk: signer.jwk, jwksStatus: 500 });
  const outageApp = createApp(config, outage.dependencies);
  t.after(() => outageApp.close());
  assert.equal((await request(outageApp, await signer.sign())).statusCode, 200, "a JWKS outage does not lock users out");
  assert.equal(outage.userChecks(), 1);

  const refused = createBackend({ jwk: signer.jwk, jwksStatus: 500, userStatus: 401 });
  const refusedApp = createApp(config, refused.dependencies);
  t.after(() => refusedApp.close());
  assert.equal((await request(refusedApp, await signer.sign())).statusCode, 401);
  assert.equal(refused.userChecks(), 1, "one Auth check, not two");
});

test("requests that change state keep the authoritative Auth check", async (t) => {
  const signer = await createSigner();
  const backend = createBackend({ jwk: signer.jwk });
  const app = createApp(config, backend.dependencies);
  t.after(() => app.close());
  const token = await signer.sign();

  const organizationId = "00000000-0000-4000-8000-000000000001";
  const entityId = "00000000-0000-4000-8000-000000000002";
  // Request bodies are validated before authentication runs, so each body must be well formed.
  const writes = [
    ["POST", "/v1/devices", { organizationId, platform: "web", label: "Test" }],
    ["PUT", `/v1/conversations/${entityId}/read`, { lastReadMessageId: null }],
    ["PATCH", `/v1/contacts/${entityId}`, { displayName: "Alice", email: null, version: 1, phones: [] }],
    ["DELETE", `/v1/contacts/${entityId}`],
  ];
  for (const [method, url, payload] of writes) {
    const before = backend.userChecks();
    const response = await request(app, token, { method, url, payload });
    assert.notEqual(response.statusCode, 401, `${method} ${url}`);
    assert.equal(backend.userChecks(), before + 1, `${method} ${url} asks Auth exactly once`);
  }
  assert.equal(backend.jwksFetches(), 0, "state changes never rely on the local verification");

  const revoked = createBackend({ jwk: signer.jwk, userStatus: 403 });
  const revokedApp = createApp(config, revoked.dependencies);
  t.after(() => revokedApp.close());
  const [method, url, payload] = writes[0];
  assert.equal((await request(revokedApp, token, { method, url, payload })).statusCode, 401, "a signed-out session cannot write");
});

test("requests without a usable bearer token never reach Supabase", async (t) => {
  const signer = await createSigner();
  const backend = createBackend({ jwk: signer.jwk });
  const app = createApp(config, backend.dependencies);
  t.after(() => app.close());

  assert.equal((await app.inject({ method: "GET", url: "/v1/services" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/v1/services", headers: { authorization: "Basic abc" } })).statusCode, 401);
  assert.deepEqual(backend.requests, []);
});
