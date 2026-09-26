import { randomUUID } from "node:crypto";
import { setTimeout as sleepTimer } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";
import type { Database } from "@onoff/contracts";
import { loadConfig } from "@onoff/api/config";
import { deliverCustomerWebhookBatch, webhookStore } from "@onoff/api/customer-webhooks";

const config = loadConfig();
const supabaseUrl = new URL(config.SUPABASE_URL);
if (["localhost", "127.0.0.1", "::1"].includes(supabaseUrl.hostname)) {
  throw new Error("Le worker refuse toute instance Supabase locale; configurez le projet hébergé.");
}
const serviceKey = config.SUPABASE_SECRET_KEY;
const accountSid = config.TWILIO_ACCOUNT_SID;
const apiKeySid = config.TWILIO_API_KEY_SID;
const apiKeySecret = config.TWILIO_API_KEY_SECRET;
if (!serviceKey || !accountSid || !apiKeySid || !apiKeySecret) {
  throw new Error("Le worker exige la clé Supabase serveur et les credentials Twilio de l'environnement ciblé.");
}
const providerAccountSid = accountSid as string;

const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 30_000);
if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 5_000 || pollIntervalMs > 300_000) {
  throw new Error("WORKER_POLL_INTERVAL_MS doit être un entier entre 5000 et 300000.");
}

const supabase = createClient<Database>(config.SUPABASE_URL, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const provider = twilio(apiKeySid, apiKeySecret, {
  accountSid: providerAccountSid,
});
const workerId = randomUUID();
let stopping = false;
const shutdownSignal = new AbortController();

const providerStatuses = new Set([
  "initiated", "ringing", "in-progress", "completed", "busy", "no-answer", "canceled", "failed",
]);

function safeErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const record = error as { code?: unknown; message?: unknown; name?: unknown };
  if (typeof record.code === "number" && Number.isSafeInteger(record.code)) return `provider_${record.code}`;
  if (typeof record.message === "string" && /^(?:device_)?database_[A-Z0-9]+$/.test(record.message)) return record.message;
  if (record.message === "unrecognized_provider_status") return record.message;
  if (record.name === "Error" || record.name === "TypeError" || record.name === "AbortError" || record.name === "RestException") return record.name;
  return "unknown";
}

function retryDelaySeconds(attempts: number): number {
  const base = Math.min(3600, 30 * 2 ** Math.min(attempts, 7));
  return Math.round(base * (0.9 + Math.random() * 0.2));
}

async function reconcileOpenCalls(): Promise<void> {
  const { data: legs, error, count } = await supabase
    .from("call_legs")
    .select("id, organization_id, call_id, provider_call_sid, parent_call_sid, status, reconcile_attempts, reconcile_after", { count: "exact" })
    .in("status", ["initiated", "ringing", "answered"])
    .lte("reconcile_after", new Date().toISOString())
    .order("reconcile_after", { ascending: true })
    .limit(20);

  if (error) {
    console.error(JSON.stringify({ level: "error", workerId, task: "reconcile_calls", code: error.code }));
    return;
  }
  if (legs?.length) {
    console.info(JSON.stringify({
      level: "info", workerId, task: "reconcile_calls_queue", queueDepth: count ?? legs.length,
      fetchedCount: legs.length,
      oldestDueAgeSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(legs[0]!.reconcile_after)) / 1000)),
    }));
  }

  for (const leg of legs ?? []) {
    let failed = false;
    let nextDelaySeconds = 300;
    try {
      const remote = await provider.calls(leg.provider_call_sid).fetch();
      const status = providerStatuses.has(remote.status) ? remote.status : remote.status === "queued" ? "initiated" : null;
      if (!status) throw new Error("unrecognized_provider_status");
      const duration = remote.duration && /^\d+$/.test(remote.duration) ? Number(remote.duration) : null;
      const { error: applyError } = await supabase.rpc("apply_call_status", {
        p_account_sid: providerAccountSid,
        p_call_sid: leg.provider_call_sid,
        p_parent_call_sid: leg.parent_call_sid ?? leg.provider_call_sid,
        p_call_status: status,
        p_call_duration: Number.isInteger(duration) ? duration : null,
        p_provider_event_at: null,
        p_provider_sequence_number: null,
      });
      if (applyError) throw new Error(`database_${applyError.code}`);
      const clientTarget = remote.to?.startsWith("client:") ? remote.to.slice("client:".length) : "";
      if ((status === "in-progress" || status === "completed")
          && clientTarget.length > 0 && clientTarget.length <= 121) {
        const { error: deviceError } = await supabase.rpc("record_answered_call_device", {
          p_account_sid: providerAccountSid,
          p_call_sid: leg.provider_call_sid,
          p_voice_identity: clientTarget,
        });
        if (deviceError) throw new Error(`device_database_${deviceError.code}`);
      }
    } catch (error) {
      failed = true;
      nextDelaySeconds = Math.min(3600, 30 * 2 ** Math.min(leg.reconcile_attempts, 7));
      const errorCode = safeErrorCode(error);
      console.error(JSON.stringify({ level: "warn", workerId, task: "reconcile_call", jobId: leg.id, callLegId: leg.id, organizationId: leg.organization_id, callId: leg.call_id, callSid: leg.provider_call_sid, parentCallSid: leg.parent_call_sid, providerStatus: leg.status, errorCode }));
    }

    const { error: scheduleError } = await supabase.rpc("record_call_leg_reconciliation", {
      p_call_leg_id: leg.id,
      p_next_attempt_at: new Date(Date.now() + nextDelaySeconds * 1000).toISOString(),
      p_failed: failed,
    });
    if (scheduleError) {
      console.error(JSON.stringify({ level: "error", workerId, task: "schedule_call_reconciliation", jobId: leg.id, callLegId: leg.id, organizationId: leg.organization_id, callId: leg.call_id, callSid: leg.provider_call_sid, code: scheduleError.code }));
    }
  }
}

async function reconcileOpenMessages(): Promise<void> {
  const { data: tasks, error, count } = await supabase
    .from("message_reconciliation_tasks")
    .select("organization_id, message_id, next_attempt_at, attempts, manual_review_required", { count: "exact" })
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(20);

  if (error) {
    console.error(JSON.stringify({ level: "error", workerId, task: "reconcile_messages", code: error.code }));
    return;
  }
  if (!tasks?.length) return;
  console.info(JSON.stringify({
    level: "info", workerId, task: "reconcile_messages_queue", queueDepth: count ?? tasks.length,
    fetchedCount: tasks.length,
    manualReviewCountInBatch: tasks.filter((task) => task.manual_review_required).length,
    oldestDueAgeSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(tasks[0]!.next_attempt_at)) / 1000)),
  }));

  const { data: messages, error: messageError } = await supabase
    .from("messages")
    .select("id, organization_id, status, provider_message_sid, created_at")
    .in("id", tasks.map((task) => task.message_id));
  if (messageError) {
    console.error(JSON.stringify({ level: "error", workerId, task: "load_messages_for_reconciliation", code: messageError.code }));
    return;
  }
  const messagesById = new Map((messages ?? []).map((message) => [message.id, message]));

  for (const task of tasks) {
    const message = messagesById.get(task.message_id);
    if (!message || message.organization_id !== task.organization_id || !["submitting", "unknown", "sent"].includes(message.status)) continue;

    const scheduleNext = async (delaySeconds: number, manualReviewRequired: boolean): Promise<void> => {
      const { data: newlyFlagged, error: scheduleError } = await supabase.rpc("record_message_reconciliation", {
        p_message_id: task.message_id,
        p_next_attempt_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
        p_manual_review_required: manualReviewRequired,
      });
      if (scheduleError) {
        console.error(JSON.stringify({ level: "error", workerId, task: "schedule_message_reconciliation", jobId: task.message_id, organizationId: task.organization_id, messageId: task.message_id, messageSid: message.provider_message_sid ?? undefined, code: scheduleError.code }));
      } else if (newlyFlagged === true) {
        console.error(JSON.stringify({ level: "error", workerId, task: "message_requires_manual_reconciliation", jobId: task.message_id, organizationId: task.organization_id, messageId: task.message_id, messageSid: message.provider_message_sid ?? undefined }));
      }
    };

    if (!message.provider_message_sid) {
      const oldEnough = Date.now() - Date.parse(message.created_at) >= 120_000;
      await scheduleNext(oldEnough ? 3600 : 30, oldEnough);
      continue;
    }

    try {
      const remote = await provider.messages(message.provider_message_sid).fetch();
      const acceptedStatuses = new Set(["accepted", "queued", "sending", "sent", "delivered", "undelivered", "failed", "read"]);
      if (!acceptedStatuses.has(remote.status)) throw new Error("unrecognized_provider_status");
      const { error: applyError } = await supabase.rpc("apply_message_status", {
        p_account_sid: providerAccountSid,
        p_message_id: task.message_id,
        p_message_sid: remote.sid,
        p_status: remote.status,
        ...(remote.errorCode == null ? {} : { p_error_code: String(remote.errorCode) }),
      });
      if (applyError) throw new Error(`database_${applyError.code}`);

      const delaySeconds = remote.status === "sent" ? 12 * 3600 : retryDelaySeconds(task.attempts);
      await scheduleNext(delaySeconds, false);
    } catch (error) {
      const nextDelaySeconds = retryDelaySeconds(task.attempts);
      const manualReviewRequired = task.attempts >= 6;
      await scheduleNext(manualReviewRequired ? 3600 : nextDelaySeconds, manualReviewRequired);
      const errorCode = safeErrorCode(error);
      console.error(JSON.stringify({ level: "warn", workerId, task: "reconcile_message", jobId: task.message_id, organizationId: task.organization_id, messageId: task.message_id, messageSid: message.provider_message_sid, providerStatus: message.status, errorCode }));
    }
  }
}

async function runCycle(): Promise<void> {
  const startedAt = Date.now();
  const { error } = await supabase.rpc("expire_stale_call_work");
  if (error) console.error(JSON.stringify({ level: "warn", workerId, task: "expire_stale_work", code: error.code }));
  await reconcileOpenCalls();
  await reconcileOpenMessages();
  console.info(JSON.stringify({ level: "info", workerId, task: "cycle_completed", durationMs: Date.now() - startedAt }));
}

async function sleep(ms: number): Promise<void> {
  try {
    await sleepTimer(ms, undefined, { signal: shutdownSignal.signal });
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) throw error;
  }
}

async function run(): Promise<void> {
  console.info(JSON.stringify({ level: "info", workerId, event: "started", pollIntervalMs }));
  while (!stopping) {
    const startedAt = Date.now();
    await runCycle().catch((error: unknown) => {
      const errorCode = error instanceof Error ? error.name : "unknown";
      console.error(JSON.stringify({ level: "error", workerId, event: "cycle_failed", errorCode }));
    });
    await sleep(Math.max(0, pollIntervalMs - (Date.now() - startedAt)));
  }
}

function requestShutdown(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  shutdownSignal.abort();
  console.info(JSON.stringify({ level: "info", workerId, event: "shutdown_requested", signal }));
}

process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));
async function runCustomerWebhooks(): Promise<void> {
  if (!config.WEBHOOK_ENCRYPTION_KEY) return;
  const store = webhookStore(supabase);
  let lastMaintenance = 0;
  while (!stopping) {
    try {
      const presence = await store.rpc("refresh_webhook_reachability", {});
      if (presence.error) throw new Error("webhook_presence_failed");
      if (Date.now() - lastMaintenance > 3_600_000) {
        const cleanup = await store.rpc("prune_customer_webhooks", {});
        if (cleanup.error) throw new Error("webhook_cleanup_failed");
        lastMaintenance = Date.now();
      }
      const delivered = await deliverCustomerWebhookBatch(store, config.WEBHOOK_ENCRYPTION_KEY);
      if (delivered) console.info(JSON.stringify({ level: "info", workerId, task: "customer_webhooks", attempted: delivered }));
    } catch {
      console.error(JSON.stringify({ level: "error", workerId, task: "customer_webhooks", code: "delivery_cycle_failed" }));
    }
    await sleep(5000);
  }
}
await Promise.all([run(), runCustomerWebhooks()]);
