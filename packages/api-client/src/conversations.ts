export type Contact = { id: string; display_name: string; email: string | null; version: number; contact_phones: { id: string; phone_number: string; label: string }[] };
export type CallRecord = { id: string; direction: "inbound" | "outbound"; remote_number: string; remoteContactName: string | null; status: string; created_at: string; duration_seconds: number | null };
export type Conversation = { id: string; lineId: string; remoteNumber: string; remoteContactName: string | null; lastMessageAt: string | null; lastMessage: { id: string; body: string; direction: string; status: string; created_at: string } | null; unread: boolean };
export type MessageRecord = { id: string; direction: "inbound" | "outbound"; body: string; status: string; provider_error_code: string | null; created_at: string; sent_at: string | null; delivered_at: string | null };

export type InboxConversation = {
  key: string;
  smsConversationId: string | null;
  remoteNumber: string;
  name: string | null;
  updatedAt: string | null;
  preview: string;
  lastKind: "message" | "call";
  unread: boolean;
  hasMissedCall: boolean;
  calls: CallRecord[];
};

// Calls and SMS share an identity within a line. A call-only thread does not
// invent a server conversation ID; the first SMS creates that resource normally.
export function buildInbox(lineId: string, conversations: Conversation[], calls: CallRecord[]): InboxConversation[] {
  const inbox = new Map<string, InboxConversation>();
  for (const conversation of conversations) {
    if (conversation.lineId !== lineId) continue;
    const number = phoneKey(conversation.remoteNumber);
    inbox.set(number, {
      key: `${lineId}:${number}`, smsConversationId: conversation.id,
      remoteNumber: conversation.remoteNumber, name: conversation.remoteContactName,
      updatedAt: conversation.lastMessage?.created_at ?? conversation.lastMessageAt,
      preview: conversation.lastMessage ? `${conversation.lastMessage.direction === "outbound" ? "Vous : " : ""}${conversation.lastMessage.body}` : "Nouvelle conversation",
      lastKind: "message", unread: conversation.unread, hasMissedCall: false, calls: [],
    });
  }
  for (const call of calls) {
    const number = phoneKey(call.remote_number);
    let thread = inbox.get(number);
    if (!thread) {
      thread = { key: `${lineId}:${number}`, smsConversationId: null, remoteNumber: call.remote_number,
        name: call.remoteContactName, updatedAt: null, preview: "", lastKind: "call", unread: false, hasMissedCall: false, calls: [] };
      inbox.set(number, thread);
    }
    thread.calls.push(call);
    thread.hasMissedCall ||= isMissedCall(call);
    if (!thread.updatedAt || call.created_at > thread.updatedAt) {
      thread.updatedAt = call.created_at;
      thread.preview = callLabel(call);
      thread.lastKind = "call";
      thread.name = call.remoteContactName ?? thread.name;
    }
  }
  return [...inbox.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.key.localeCompare(b.key));
}

export type TimelineEvent =
  | { kind: "message"; id: string; createdAt: string; message: MessageRecord }
  | { kind: "call"; id: string; createdAt: string; call: CallRecord };

// Keep event rendering separate from SMS resources so future recording and
// transcript events can join this chronology without adding another inbox.
export function buildTimeline(messages: MessageRecord[], calls: CallRecord[]): TimelineEvent[] {
  return [
    ...messages.map((message): TimelineEvent => ({ kind: "message", id: `message:${message.id}`, createdAt: message.created_at, message })),
    ...calls.map((call): TimelineEvent => ({ kind: "call", id: `call:${call.id}`, createdAt: call.created_at, call })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function phoneKey(value: string): string { return value.replace(/[\s().-]/g, ""); }
export function isMissedCall(call: CallRecord): boolean { return call.direction === "inbound" && ["missed", "no-answer", "busy"].includes(call.status); }
export function callLabel(call: CallRecord): string {
  if (isMissedCall(call)) return "Appel manqué";
  if (call.status === "failed") return "Appel échoué";
  if (call.status === "canceled") return "Appel annulé";
  if (call.status === "busy") return "Ligne occupée";
  if (call.status === "no-answer") return "Sans réponse";
  return call.direction === "inbound" ? "Appel entrant" : "Appel sortant";
}
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min${seconds % 60 ? ` ${String(seconds % 60).padStart(2, "0")}` : ""}` : `${seconds} s`;
}
export function messageStatus(status: string): string {
  return ({ queued: "En attente", submitting: "Envoi en cours", sent: "Envoyé", delivered: "Livré", received: "Reçu", failed: "Échec de l’envoi", undelivered: "Non livré", unknown: "À vérifier" } as Record<string, string>)[status] ?? "En cours";
}
export function initials(name: string): string {
  if (/^[+\d\s().-]+$/.test(name)) return name.replace(/\D/g, "").slice(-2);
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}
export function formatPhone(value: string): string {
  const phone = phoneKey(value);
  return /^\+33\d{9}$/.test(phone) ? phone.replace(/^(\+33)(\d)(\d{2})(\d{2})(\d{2})(\d{2})$/, "$1 $2 $3 $4 $5 $6") : value;
}
