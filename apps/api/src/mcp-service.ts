import { createHash } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhoneNumber, uuidSchema, type Database, type McpPermission, type McpSmsAction, type McpSmsDraft, type MessageCreate } from "@onoff/contracts";
import type { AppConfig } from "./config.js";
import { checked, mcpError, mcpStore, type GrantRow, type McpStore } from "./mcp-store.js";
import { deliverPreparedSms, type SmsProvider } from "./sms-delivery.js";

export type McpContext = { userId: string; grant: GrantRow; db: SupabaseClient<Database> };
export const mcpResource = (config: AppConfig) => `${config.API_PUBLIC_URL.replace(/\/$/, "")}/mcp`;
export function requirePermission(context: McpContext, permission: McpPermission): void {
  if (!context.grant.permissions.includes(permission)) mcpError("Cette connexion n’autorise pas cette action. Révoquez-la dans les réglages Onoff, puis reconnectez l’assistant avec les permissions souhaitées.", 403, "permission_denied");
}
export async function activeGrant(store: McpStore, userId: string, grantId: string): Promise<GrantRow> {
  const grant = checked(await store.from("mcp_grants").select("*").eq("id", grantId).eq("user_id", userId).is("revoked_at", null).maybeSingle());
  if (!grant) mcpError("Cette connexion a été révoquée. Reconnectez votre assistant.", 403, "grant_revoked");
  const member = checked(await store.from("memberships").select("organization_id").eq("organization_id", grant.organization_id).eq("user_id", userId).eq("status", "active").maybeSingle());
  const organization = checked(await store.from("organizations").select("id").eq("id", grant.organization_id).eq("status", "active").maybeSingle());
  if (!member || !organization) mcpError("L’accès à cette organisation a été retiré.", 403, "membership_revoked");
  return grant;
}
export async function requireLine(store: McpStore, context: McpContext, lineId: string, permission: McpPermission) {
  requirePermission(context, permission);
  if (!context.grant.line_ids.includes(lineId)) mcpError("Cette ligne n’est pas autorisée pour cette connexion.", 403);
  const voice = permission.startsWith("calls:");
  const assignment = checked(await store.from("line_assignments").select("line_id, can_voice, can_sms").eq("organization_id", context.grant.organization_id).eq("line_id", lineId).eq("user_id", context.userId).eq("status", "active").maybeSingle());
  const line = checked(await store.from("lines").select("id, phone_number, voice_enabled, sms_enabled").eq("organization_id", context.grant.organization_id).eq("id", lineId).eq("status", "active").maybeSingle());
  if (!assignment || !line || !(voice ? assignment.can_voice && line.voice_enabled : assignment.can_sms && line.sms_enabled)) mcpError("Les droits sur cette ligne ont changé.", 403);
  return line;
}

export type PageInput = { limit?: number | undefined; cursor?: string | undefined };
function pageInput(input: PageInput) {
  const limit = input.limit ?? 30;
  let cursor: { date: string; id: string } | null = null;
  if (input.cursor) {
    try {
      const value = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as { date: string; id: string };
      if (typeof value.date !== "string" || !Number.isFinite(Date.parse(value.date)) || !uuidSchema.safeParse(value.id).success) throw new Error();
      cursor = { date: new Date(value.date).toISOString(), id: value.id };
    } catch { mcpError("Curseur invalide."); }
  }
  return { limit, cursor };
}
function pageResult<T extends { id: string }>(rows: T[], limit: number, timestamp: (row: T) => string) {
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: more && last ? Buffer.from(JSON.stringify({ date: timestamp(last), id: last.id })).toString("base64url") : null, partial: more };
}
export async function searchContacts(context: McpContext, input: PageInput & { query?: string | undefined }) {
  requirePermission(context, "contacts:read");
  const { limit, cursor } = pageInput(input);
  let query = context.db.from("contacts").select("id, display_name, email, version, created_at, contact_phones(id, phone_number, label)")
    .eq("organization_id", context.grant.organization_id).is("archived_at", null).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (cursor) query = query.or(`created_at.lt.${cursor.date},and(created_at.eq.${cursor.date},id.lt.${cursor.id})`);
  const text = input.query?.trim();
  if (text) {
    const phone = normalizePhoneNumber(text);
    if (phone) {
      const phones = checked(await context.db.from("contact_phones").select("contact_id").eq("organization_id", context.grant.organization_id).eq("phone_number", phone).limit(1000));
      if (!phones?.length) return { items: [], nextCursor: null, partial: false };
      if (phones.length >= 1000) mcpError("Recherche trop large. Précisez le nom du contact.");
      query = query.in("id", [...new Set(phones.map(row => row.contact_id))]);
    } else query = query.ilike(text.includes("@") ? "email" : "display_name", `%${text.replace(/[\\%_]/g, "\\$&")}%`);
  }
  return pageResult(checked(await query) ?? [], limit, row => row.created_at);
}
export async function listCalls(context: McpContext, store: McpStore, input: PageInput & { lineId: string }) {
  await requireLine(store, context, input.lineId, "calls:read");
  const { limit, cursor } = pageInput(input);
  let query = context.db.from("calls").select("id, line_id, direction, remote_number, status, started_at, answered_at, ended_at, duration_seconds, created_at")
    .eq("organization_id", context.grant.organization_id).eq("line_id", input.lineId).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (cursor) query = query.or(`created_at.lt.${cursor.date},and(created_at.eq.${cursor.date},id.lt.${cursor.id})`);
  return pageResult(checked(await query) ?? [], limit, row => row.created_at);
}
export async function listConversations(context: McpContext, store: McpStore, input: PageInput & { lineId: string }) {
  await requireLine(store, context, input.lineId, "messages:read");
  const { limit, cursor } = pageInput(input);
  let query = context.db.from("conversations").select("id, line_id, remote_number, last_message_at")
    .eq("organization_id", context.grant.organization_id).eq("line_id", input.lineId).not("last_message_at", "is", null)
    .order("last_message_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (cursor) query = query.or(`last_message_at.lt.${cursor.date},and(last_message_at.eq.${cursor.date},id.lt.${cursor.id})`);
  return pageResult(checked(await query) ?? [], limit, row => row.last_message_at!);
}
export async function conversationMessages(context: McpContext, store: McpStore, input: PageInput & { conversationId: string }) {
  requirePermission(context, "messages:read");
  const conversation = checked(await context.db.from("conversations").select("id, line_id, remote_number").eq("id", input.conversationId).eq("organization_id", context.grant.organization_id).maybeSingle());
  if (!conversation) mcpError("Conversation introuvable.", 404);
  await requireLine(store, context, conversation.line_id, "messages:read");
  const { limit, cursor } = pageInput(input);
  let query = context.db.from("messages").select("id, direction, body, status, created_at, sent_at, delivered_at")
    .eq("organization_id", context.grant.organization_id).eq("conversation_id", conversation.id).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (cursor) query = query.or(`created_at.lt.${cursor.date},and(created_at.eq.${cursor.date},id.lt.${cursor.id})`);
  const page = pageResult(checked(await query) ?? [], limit, row => row.created_at);
  return { ...page, items: page.items.reverse(), conversation, contentIsUntrusted: true };
}

export async function smsAction(store: McpStore, userId: string, id: string, grantId?: string): Promise<McpSmsAction> {
  let query = store.from("mcp_sms_drafts").select("*").eq("id", id).eq("user_id", userId);
  if (grantId) query = query.eq("grant_id", grantId);
  const draft = checked(await query.maybeSingle());
  if (!draft) mcpError("Brouillon introuvable.", 404);
  const grant = await activeGrant(store, userId, draft.grant_id);
  const line = await requireLine(store, { userId, grant, db: store as unknown as SupabaseClient<Database> }, draft.line_id, "messages:send");
  const message = draft.message_id ? checked(await store.from("messages").select("status, provider_message_sid").eq("id", draft.message_id).eq("organization_id", draft.organization_id).maybeSingle()) : null;
  return { ...draft, clientName: grant.client_name, lineNumber: line.phone_number, messageStatus: message?.status ?? null, submissionConfirmed: Boolean(message?.provider_message_sid) };
}

export function assertSmsEnabled(config: AppConfig, destination: string): void {
  if (config.OPERATIONS_PAUSED) mcpError(config.OPERATIONS_PAUSE_MESSAGE, 503, "operations_paused");
  if (!config.SMS_ENABLED || !config.SUPABASE_SECRET_KEY || !config.TWILIO_ACCOUNT_SID || !config.TWILIO_API_KEY_SID || !config.TWILIO_API_KEY_SECRET) mcpError("Le service SMS n’est pas activé.", 503, "sms_disabled");
  if (!config.TWILIO_ALLOWED_DESTINATIONS.split(",").map(s => s.trim()).filter(Boolean).some(prefix => destination.startsWith(prefix)) || !config.SMS_ALLOWED_RECIPIENTS.split(",").map(s => s.trim()).includes(destination)) mcpError("Ce destinataire n’est pas autorisé pour les SMS.", 403, "destination_not_allowed");
}
export async function sendDraft(config: AppConfig, service: SupabaseClient<Database>, userId: string, draft: McpSmsDraft, provider: (key: string, secret: string, account: string) => SmsProvider, log: FastifyBaseLogger, requestId: string) {
  const store = mcpStore(service);
  await smsAction(store, userId, draft.id, draft.grant_id);
  assertSmsEnabled(config, draft.destination);
  const allowed = checked(await service.rpc("consume_api_rate_limit", { p_user_id: userId, p_operation: "sms_send", p_window_seconds: 60, p_max_requests: 10 }));
  if (!allowed) mcpError("Trop de tentatives d’envoi. Réessayez dans une minute.", 429);
  const input: MessageCreate = { organizationId: draft.organization_id, lineId: draft.line_id, destination: draft.destination, body: draft.body };
  const prepared = checked(await store.rpc("mcp_prepare_sms", { p_user: userId, p_grant: draft.grant_id, p_draft: draft.id, p_hash: createHash("sha256").update(JSON.stringify(input)).digest("hex") }));
  const outgoing = prepared as { messageId?: string; conversationId?: string; fromNumber?: string; destination?: string; replayed?: boolean } | null;
  if (!outgoing?.messageId || !outgoing.conversationId || !outgoing.fromNumber || !outgoing.destination) mcpError("L’envoi ne peut pas être préparé.", 503);
  return deliverPreparedSms(config, service, service, provider, input, outgoing as { messageId: string; conversationId: string; fromNumber: string; destination: string; replayed?: boolean }, log, requestId);
}
