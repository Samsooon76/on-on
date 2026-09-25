import assert from "node:assert/strict";
import test from "node:test";
import { createVoiceAccessToken } from "../dist/voice.js";

const credentials = {
  accountSid: "AC00000000000000000000000000000000",
  apiKeySid: "SK00000000000000000000000000000000",
  apiKeySecret: "local-test-key-secret",
  twimlAppSid: "AP00000000000000000000000000000000",
};

test("voice access tokens are scoped to the server generated identity and app", () => {
  const token = createVoiceAccessToken(credentials, "web_0123456789abcdef", 900);
  const [, encodedPayload] = token.split(".");
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  assert.equal(payload.grants.identity, "web_0123456789abcdef");
  assert.deepEqual(payload.grants.voice, {
    incoming: { allow: true },
    outgoing: { application_sid: credentials.twimlAppSid },
  });
  assert.equal(payload.exp - payload.iat, 900);
});

test("mobile access tokens include only the configured mobile push credential", () => {
  const pushCredentialSid = "CR00000000000000000000000000000000";
  const token = createVoiceAccessToken({ ...credentials, pushCredentialSid }, "ios_0123456789abcdef", 900);
  const [, encodedPayload] = token.split(".");
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  assert.equal(payload.grants.identity, "ios_0123456789abcdef");
  assert.deepEqual(payload.grants.voice.incoming, { allow: true });
  assert.equal(payload.grants.voice.push_credential_sid, pushCredentialSid);
});

test("voice tokens reject identities outside Twilio's allowed character set", () => {
  assert.throws(() => createVoiceAccessToken(credentials, "web user"), /identité vocale/i);
});
