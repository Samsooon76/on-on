import type { CallRecord, Conversation } from "./conversations.js";

// The last known state of a user's inbox, kept on the device so the app can show it
// immediately while the current data loads. It holds phone numbers and message
// previews: clients must delete it on sign-out and never share it across users.

/** Bump when the shape changes: snapshots written by another version are ignored. */
export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Newest items kept per list; older history is fetched normally. */
export const SNAPSHOT_HISTORY_LIMIT = 40;

export type WorkspaceSnapshot<Organization, Line> = {
  version: typeof SNAPSHOT_VERSION;
  savedAt: number;
  userId: string;
  organizationId: string;
  lineId: string;
  organizations: Organization[];
  lines: Line[];
  conversations: Conversation[];
  calls: CallRecord[];
};

export function snapshotKey(userId: string): string {
  return `onoff.workspace.v${SNAPSHOT_VERSION}.${userId}`;
}

function newestFirst<T>(items: T[], timestamp: (item: T) => string | null, id: (item: T) => string): T[] {
  return [...items].sort((a, b) => (timestamp(b) ?? "").localeCompare(timestamp(a) ?? "") || id(b).localeCompare(id(a)));
}

/** Keeps only what the line's first screen needs, newest first. */
export function createSnapshot<Organization, Line>(input: {
  userId: string;
  organizationId: string;
  lineId: string;
  organizations: Organization[];
  lines: Line[];
  conversations: Conversation[];
  calls: CallRecord[];
}, now: number = Date.now()): WorkspaceSnapshot<Organization, Line> {
  return {
    version: SNAPSHOT_VERSION,
    savedAt: now,
    userId: input.userId,
    organizationId: input.organizationId,
    lineId: input.lineId,
    organizations: input.organizations,
    lines: input.lines,
    conversations: newestFirst(input.conversations.filter((item) => item.lineId === input.lineId), (item) => item.lastMessageAt, (item) => item.id).slice(0, SNAPSHOT_HISTORY_LIMIT),
    calls: newestFirst(input.calls, (item) => item.created_at, (item) => item.id).slice(0, SNAPSHOT_HISTORY_LIMIT),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isNullableText = (value: unknown): value is string | null => value === null || typeof value === "string";

function isConversation(value: unknown, lineId: string): value is Conversation {
  if (!isRecord(value) || !isText(value.id) || value.lineId !== lineId || !isText(value.remoteNumber) || !isNullableText(value.remoteContactName)
    || !isNullableText(value.lastMessageAt) || typeof value.unread !== "boolean") return false;
  const message = value.lastMessage;
  return message === null || (isRecord(message) && isText(message.id) && isText(message.body) && isText(message.direction) && isText(message.status) && isText(message.created_at));
}

function isCall(value: unknown): value is CallRecord {
  return isRecord(value) && isText(value.id) && (value.direction === "inbound" || value.direction === "outbound") && isText(value.remote_number)
    && isNullableText(value.remoteContactName) && isText(value.status) && isText(value.created_at)
    && (value.duration_seconds === null || typeof value.duration_seconds === "number");
}

/**
 * Reads a stored snapshot. Anything unexpected — another user, another version, too old,
 * damaged or hand-edited content — yields null so the app simply loads normally.
 */
export function parseSnapshot<Organization, Line>(raw: string | null | undefined, userId: string, now: number = Date.now()): WorkspaceSnapshot<Organization, Line> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== SNAPSHOT_VERSION || value.userId !== userId) return null;
    if (typeof value.savedAt !== "number" || !Number.isFinite(value.savedAt) || value.savedAt > now + 5 * 60_000 || now - value.savedAt > SNAPSHOT_MAX_AGE_MS) return null;
    if (!isText(value.organizationId) || !value.organizationId || !isText(value.lineId) || !value.lineId) return null;
    if (!Array.isArray(value.organizations) || !Array.isArray(value.lines) || !Array.isArray(value.conversations) || !Array.isArray(value.calls)) return null;
    if (!value.organizations.every(isRecord) || !value.lines.every(isRecord)) return null;
    if (!value.conversations.every((item) => isConversation(item, value.lineId as string)) || !value.calls.every(isCall)) return null;
    return value as WorkspaceSnapshot<Organization, Line>;
  } catch {
    return null;
  }
}
