import { phoneKey, type InboxConversation } from "@onoff/api-client";

export type InboxFilter = "all" | "unread" | "missed";

export function filterInbox(inbox: InboxConversation[], search: string, filter: InboxFilter): InboxConversation[] {
  const query = search.trim().toLocaleLowerCase("fr");
  const digits = query.replace(/\D/g, "");
  return inbox.filter((thread) => {
    const matches = `${thread.name ?? ""} ${thread.remoteNumber} ${thread.preview}`.toLocaleLowerCase("fr").includes(query)
      || (digits.length > 2 && phoneKey(thread.remoteNumber).includes(digits));
    return matches && (filter === "all" || (filter === "unread" ? thread.unread : thread.hasMissedCall));
  });
}

// A fresh page updates delivery/read state without dropping older loaded events.
export function mergeRecords<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  return [...new Map([...current, ...incoming].map((item) => [item.id, item])).values()];
}

export function conversationDay(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Aujourd’hui";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Hier";
  return date.toLocaleDateString("fr-BE", { day: "numeric", month: "long", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}
