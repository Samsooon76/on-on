// npm install pg
// DATABASE_URL=... ONOFF_WEBHOOK_SECRET=whsec_... ONOFF_ORGANIZATION_ID=... node receiver.mjs
// Expose port 3001 through your HTTPS reverse proxy. Run inbox.sql first.
import { createServer } from "node:http";
import pg from "pg";
import { verifySignature } from "./verify-signature.mjs";

const { DATABASE_URL, ONOFF_WEBHOOK_SECRET, ONOFF_ORGANIZATION_ID } =
  process.env;
if (!DATABASE_URL || !ONOFF_WEBHOOK_SECRET || !ONOFF_ORGANIZATION_ID)
  throw new Error(
    "Configure DATABASE_URL, ONOFF_WEBHOOK_SECRET and ONOFF_ORGANIZATION_ID.",
  );
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  connectionTimeoutMillis: 2000,
  query_timeout: 3000,
});
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/webhooks/onoff") {
    response.writeHead(404).end();
    return;
  }
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 64 * 1024) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    if (
      !verifySignature(
        raw,
        request.headers["x-onoff-signature"],
        ONOFF_WEBHOOK_SECRET,
      )
    ) {
      response.writeHead(401).end();
      return;
    }
    let event;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (
      !event ||
      !uuid.test(event.id) ||
      typeof event.type !== "string" ||
      event.apiVersion !== "v1" ||
      event.organizationId !== ONOFF_ORGANIZATION_ID
    ) {
      response.writeHead(400).end();
      return;
    }
    // One durable insert, including duplicates, before acknowledging delivery.
    // Your own worker processes pending rows asynchronously and records completion.
    await pool.query(
      "insert into onoff_webhook_inbox(event_id, event_type, payload) values ($1, $2, $3::jsonb) on conflict (event_id) do nothing",
      [event.id, event.type, JSON.stringify(event)],
    );
    response.writeHead(204).end();
  } catch {
    // Do not log SMS bodies or signing secrets.
    if (!response.headersSent) response.writeHead(503).end();
  }
});
server.requestTimeout = 5000;
server.listen(3001, "127.0.0.1");
