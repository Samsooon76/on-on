import type { SupabaseClient } from "@supabase/supabase-js";
import type { FastifyBaseLogger } from "fastify";
import type { Database, MessageCreate } from "@onoff/contracts";
import type { AppConfig } from "./config.js";

export type SmsProvider = {
  messages: {
    create(input: { from: string; to: string; body: string; statusCallback: string }): Promise<{
      sid: string;
      status: string;
      errorCode?: number | null;
    }>;
  };
};

function safeProviderCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return undefined;
}

export async function deliverPreparedSms(
  config: AppConfig,
  serviceSupabase: SupabaseClient<Database>,
  readClient: SupabaseClient<Database>,
  makeSmsProvider: (key: string, secret: string, account: string) => SmsProvider,
  input: MessageCreate,
  outgoing: { messageId: string; conversationId: string; fromNumber: string; destination: string; replayed?: boolean },
  log: FastifyBaseLogger,
  requestId: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  if (outgoing.replayed) {
    const { data: existing } = await readClient.from("messages").select("id, conversation_id, status, provider_message_sid, created_at")
      .eq("id", outgoing.messageId).maybeSingle();
    log.info({ requestId, organizationId: input.organizationId, lineId: input.lineId, conversationId: outgoing.conversationId, messageId: outgoing.messageId, messageSid: existing?.provider_message_sid ?? undefined, status: existing?.status ?? "unknown", replayed: true }, "outbound message intent replayed");
    return { statusCode: 202, body: { id: outgoing.messageId, conversationId: outgoing.conversationId, status: existing?.status ?? "unknown", submissionConfirmed: Boolean(existing?.provider_message_sid), replayed: true } };
  }

  const callback = `${config.API_PUBLIC_URL.replace(/\/$/, "")}/webhooks/twilio/messages/status?messageId=${encodeURIComponent(outgoing.messageId)}`;
  const client = makeSmsProvider(config.TWILIO_API_KEY_SID!, config.TWILIO_API_KEY_SECRET!, config.TWILIO_ACCOUNT_SID!);
  try {
    const sent = await client.messages.create({ from: outgoing.fromNumber, to: outgoing.destination, body: input.body, statusCallback: callback });
    const status = sent.status === "delivered" ? "delivered"
      : sent.status === "failed" ? "failed"
        : sent.status === "undelivered" ? "undelivered"
          : sent.status === "sent" ? "sent"
            : ["accepted", "queued", "sending", "scheduled"].includes(sent.status) ? "submitting" : "unknown";
    const { data: storedResult, error: storeError } = await serviceSupabase.rpc("update_outbound_message_result", {
      p_message_id: outgoing.messageId,
      p_message_sid: sent.sid,
      p_status: status,
      ...(sent.errorCode == null ? {} : { p_error_code: String(sent.errorCode) }),
    });
    if (storeError) log.error({ code: storeError.code, requestId, messageId: outgoing.messageId }, "sent message result not stored");
    const persistedStatus = storedResult && typeof storedResult === "object" && !Array.isArray(storedResult)
      ? (storedResult as { status?: unknown }).status
      : undefined;
    const responseStatus = storeError
      ? "unknown"
      : typeof persistedStatus === "string" && ["pending", "submitting", "unknown", "sent", "delivered", "undelivered", "failed", "received"].includes(persistedStatus)
        ? persistedStatus
        : status;
    const submittedFields = { requestId, organizationId: input.organizationId, lineId: input.lineId, conversationId: outgoing.conversationId, messageId: outgoing.messageId, messageSid: sent.sid, status: responseStatus, replayed: false };
    if (storeError) log.error(submittedFields, "outbound message result uncertain");
    else log.info(submittedFields, "outbound message submitted");
    return { statusCode: 201, body: { id: outgoing.messageId, conversationId: outgoing.conversationId, status: responseStatus, submissionConfirmed: !storeError && Boolean(sent.sid) } };
  } catch (providerError) {
    const failure = providerError as { status?: number; code?: number | string };
    const providerCode = safeProviderCode(failure.code);
    const providerStatus = typeof failure.status === "number" && Number.isSafeInteger(failure.status) ? failure.status : undefined;
    const definiteFailure = providerStatus !== undefined && providerStatus >= 400 && providerStatus < 500;
    const status = definiteFailure ? "failed" : "unknown";
    const { error: storeError } = await serviceSupabase.rpc("update_outbound_message_result", {
      p_message_id: outgoing.messageId,
      // The SQL function accepts NULL when Twilio did not return a message SID.
      p_message_sid: null as unknown as string,
      p_status: status,
      ...(providerCode === undefined ? {} : { p_error_code: String(providerCode) }),
    });
    log.warn({ providerStatus, providerCode, requestId, organizationId: input.organizationId, lineId: input.lineId, messageId: outgoing.messageId }, "outbound message delivery uncertain");
    if (storeError) log.error({ code: storeError.code, requestId, messageId: outgoing.messageId }, "message outcome not stored");
    if (definiteFailure) return { statusCode: 422, body: { code: "message_failed", message: "Twilio a refusé ce message.", requestId, id: outgoing.messageId, status } };
    return { statusCode: 202, body: { id: outgoing.messageId, conversationId: outgoing.conversationId, status: storeError ? "unknown" : status } };
  }
}
