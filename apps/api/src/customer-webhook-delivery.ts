import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request } from "node:https";
import type { WebhookJob, WebhookStore } from "./customer-webhook-store.js";
import { webhookResult } from "./customer-webhook-store.js";
export { webhookStore } from "./customer-webhook-store.js";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  // Only global unicast; excludes mapped IPv4, ULA, loopback, link-local, NAT64.
  return (
    family === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !blocked.check(address, "ipv6")
  );
}
export async function resolveWebhookTarget(value: string, resolver = lookup) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    throw new Error("unsafe_url");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let timer: NodeJS.Timeout | undefined;
  try {
    const addresses = await Promise.race([
      resolver(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("dns_timeout")), 5000);
      }),
    ]);
    if (
      !addresses.length ||
      addresses.some((item) => !isPublicAddress(item.address))
    )
      throw new Error("unsafe_address");
    return { url, address: addresses[0]! };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function encryptionKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("invalid_webhook_key");
  return key;
}
export function encryptWebhookSecret(secret: string, key: string): string {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", encryptionKey(key), iv);
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}
export function decryptWebhookSecret(value: string, key: string): string {
  const [version, iv, tag, encrypted, ...extra] = value.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted || extra.length)
    throw new Error("invalid_webhook_secret");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(key),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
export const newWebhookSecret = () =>
  `whsec_${randomBytes(32).toString("base64url")}`;
export function webhookSignature(
  secret: string,
  timestamp: string,
  body: string,
) {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}
export async function postCustomerWebhook(
  job: WebhookJob,
  key: string,
): Promise<number> {
  // Re-resolve and pin a verified address at every attempt to prevent DNS rebinding.
  const { url, address } = await resolveWebhookTarget(job.url);
  const body = JSON.stringify(job.payload),
    timestamp = String(Math.floor(Date.now() / 1000));
  const signature = webhookSignature(
    decryptWebhookSecret(job.secretCiphertext, key),
    timestamp,
    body,
  );
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "POST",
      agent: false,
      family: address.family,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "user-agent": "Onoff-Webhooks/1.0",
        "x-onoff-event-id": job.payload.id,
        "x-onoff-delivery-id": job.id,
        "x-onoff-attempt": String(job.attempt),
        "x-onoff-signature": signature,
      },
    });
    const timer = setTimeout(
      () => req.destroy(new Error("delivery_timeout")),
      5000,
    );
    req.once("response", (response) => {
      clearTimeout(timer);
      resolve(response.statusCode ?? 500);
      response.destroy();
    });
    req.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end(body);
  });
}
export async function deliverCustomerWebhookBatch(
  store: WebhookStore,
  key: string,
  send = postCustomerWebhook,
) {
  const jobs =
    webhookResult(await store.rpc("claim_customer_webhooks", { p_limit: 4 })) ??
    [];
  await Promise.all(
    jobs.map(async (job) => {
      let status: number | null = null,
        error: string | null = null;
      try {
        status = await send(job, key);
        if (status < 200 || status >= 300) error = `http_${status}`;
      } catch (caught) {
        error =
          caught instanceof Error &&
          [
            "unsafe_url",
            "unsafe_address",
            "dns_timeout",
            "delivery_timeout",
          ].includes(caught.message)
            ? caught.message
            : "delivery_failed";
      }
      webhookResult(
        await store.rpc("finish_customer_webhook", {
          p_id: job.id,
          p_lease: job.leaseToken,
          p_http_status: status,
          p_error: error,
        }),
      );
    }),
  );
  return jobs.length;
}
