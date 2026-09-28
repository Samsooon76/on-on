import { z } from "zod";
import { encodeCursor } from "./cursor.js";

// Shapes returned by the list_line_conversations, list_line_calls and
// conversation_thread SQL functions. Identifiers stay plain strings here: the
// route response schemas already validate them on the way out.
const direction = z.enum(["inbound", "outbound"]);
const timestamp = z.string();

const latestMessage = z.object({
  id: z.string(), conversation_id: z.string(), body: z.string(), direction, status: z.string(), created_at: timestamp,
});

export const inboxPageSchema = z.object({
  hasMore: z.boolean(),
  items: z.array(z.object({
    id: z.string(), organization_id: z.string(), line_id: z.string(), remote_number: z.string(), last_message_at: timestamp,
    remote_contact_name: z.string().nullable(), last_message: latestMessage.nullable(), unread: z.boolean(),
  })),
});

export const callsPageSchema = z.object({
  hasMore: z.boolean(),
  items: z.array(z.object({
    id: z.string(), organization_id: z.string(), line_id: z.string(), direction, remote_number: z.string(), status: z.string(),
    started_at: timestamp.nullable(), answered_at: timestamp.nullable(), ended_at: timestamp.nullable(),
    duration_seconds: z.number().int().nullable(), created_at: timestamp, remote_contact_name: z.string().nullable(),
  })),
});

export const threadPageSchema = z.object({
  conversation: z.object({ id: z.string(), organization_id: z.string(), line_id: z.string(), remote_number: z.string() }),
  hasMore: z.boolean(),
  items: z.array(z.object({
    id: z.string(), conversation_id: z.string(), direction, body: z.string(), status: z.string(), provider_error_code: z.string().nullable(),
    created_at: timestamp, sent_at: timestamp.nullable(), delivered_at: timestamp.nullable(),
  })),
});

export function inboxResponse(page: z.infer<typeof inboxPageSchema>) {
  const last = page.items.at(-1);
  return {
    items: page.items.map((item) => ({
      id: item.id,
      lineId: item.line_id,
      remoteNumber: item.remote_number,
      remoteContactName: item.remote_contact_name,
      lastMessageAt: item.last_message_at,
      lastMessage: item.last_message,
      unread: item.unread,
    })),
    nextCursor: page.hasMore && last ? encodeCursor({ last_message_at: last.last_message_at, id: last.id }) : null,
  };
}

export function callsResponse(page: z.infer<typeof callsPageSchema>) {
  const last = page.items.at(-1);
  return {
    items: page.items.map(({ remote_contact_name, ...call }) => ({ ...call, remoteContactName: remote_contact_name })),
    nextCursor: page.hasMore && last ? encodeCursor(last) : null,
  };
}

// The database returns the newest messages first; clients render oldest first.
export function threadResponse(page: z.infer<typeof threadPageSchema>) {
  const oldest = page.items.at(-1);
  return {
    conversation: page.conversation,
    items: [...page.items].reverse(),
    nextCursor: page.hasMore && oldest ? encodeCursor(oldest) : null,
  };
}
