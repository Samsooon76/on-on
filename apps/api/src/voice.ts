import twilio from "twilio";

export type VoiceTokenCredentials = {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
  pushCredentialSid?: string;
};

export function createVoiceAccessToken(credentials: VoiceTokenCredentials, identity: string, ttlSeconds = 3600): string {
  if (!/^[a-zA-Z0-9_]{1,121}$/.test(identity)) throw new Error("Identité vocale invalide.");
  const token = new twilio.jwt.AccessToken(credentials.accountSid, credentials.apiKeySid, credentials.apiKeySecret, {
    identity,
    ttl: ttlSeconds,
  });
  token.addGrant(new twilio.jwt.AccessToken.VoiceGrant({
    outgoingApplicationSid: credentials.twimlAppSid,
    incomingAllow: true,
    ...(credentials.pushCredentialSid ? { pushCredentialSid: credentials.pushCredentialSid } : {}),
  }));
  return token.toJwt();
}
