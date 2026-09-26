import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify BEFORE parsing JSON. Secret is the complete whsec_ string. */
export function verifySignature(
  rawBody,
  header,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  if (
    !Buffer.isBuffer(rawBody) ||
    typeof header !== "string" ||
    typeof secret !== "string" ||
    !secret.startsWith("whsec_")
  )
    return false;
  const match = /^t=(\d{1,12}),v1=([a-f0-9]{64})$/.exec(header);
  if (!match || Math.abs(nowSeconds - Number(match[1])) > 300) return false;
  const expected = createHmac("sha256", secret)
    .update(match[1] + ".")
    .update(rawBody)
    .digest();
  return timingSafeEqual(expected, Buffer.from(match[2], "hex"));
}
