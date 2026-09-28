import { uuidSchema } from "@onoff/contracts";

export type PageCursor = { createdAt: string; id: string };

// What Postgres emits for timestamptz (microseconds) and what a client may send back.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Decodes a pagination cursor. `false` means the client sent something invalid.
 * With `exact`, the timestamp is returned untouched: rounding it to milliseconds
 * would let rows created within the same millisecond fall between two pages.
 */
export function decodeCursor(value: string | undefined, options: { exact?: boolean } = {}): PageCursor | null | false {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt)) || typeof parsed.id !== "string" || !uuidSchema.safeParse(parsed.id).success) return false;
    if (options.exact) return TIMESTAMP.test(parsed.createdAt) ? { createdAt: parsed.createdAt, id: parsed.id } : false;
    return { createdAt: new Date(parsed.createdAt).toISOString(), id: parsed.id };
  } catch {
    return false;
  }
}

export function encodeCursor(row: { id: string } & ({ created_at: string } | { last_message_at: string })): string {
  const createdAt = "created_at" in row ? row.created_at : row.last_message_at;
  return Buffer.from(JSON.stringify({ createdAt, id: row.id })).toString("base64url");
}
