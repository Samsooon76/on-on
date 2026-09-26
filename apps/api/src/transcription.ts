import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { transcriptionResponseSchema, type CallTranscript, type Database } from "@onoff/contracts";
import type { AppConfig } from "./config.js";
import type { CenterProvider } from "./call-center-provider.js";
import { ScribeBridge, type ScribeSocketFactory, type TranscriptSnapshot } from "./scribe-bridge.js";

type TranscriptRow = {
  id: string; call_id: string; provider_call_sid: string; stream_sid: string | null;
  status: CallTranscript["status"]; started_at: string; updated_at: string;
  snapshot: TranscriptSnapshot; error: string | null;
};
const sidSchema = z.string().regex(/^CA[0-9a-fA-F]{32}$/);
const uuid = z.string().uuid();
const problem = (message: string, statusCode = 503): never => { throw Object.assign(new Error(message), { statusCode }); };
function checked<T>(result: { data: T; error: unknown }): T {
  if (result.error) problem("La transcription est momentanément indisponible.");
  return result.data;
}
function publicTranscript(row: TranscriptRow | null): CallTranscript | null {
  return row ? { id: row.id, status: row.status, startedAt: row.started_at, updatedAt: row.updated_at, segments: row.snapshot.segments, partials: row.snapshot.partials, error: row.error } : null;
}

export function registerTranscription(app: FastifyInstance, config: AppConfig, service: SupabaseClient<Database> | null, provider: CenterProvider | null,
  validateWebhook: (request: FastifyRequest) => boolean, openSocket?: ScribeSocketFactory): void {
  // Isolate the new schema until generated database types are refreshed on deployment.
  const db = service as SupabaseClient | null;
  const available = Boolean(config.TRANSCRIPTION_ENABLED && config.ELEVENLABS_API_KEY && db && provider);
  const liveSessions = new Map<string, () => Promise<void>>();

  async function authorizedCall(request: FastifyRequest, providerSid: boolean) {
    const context = request.context;
    if (!context) problem("Session requise.", 401);
    const id = (request.params as { id: string }).id;
    let callId = id;
    if (providerSid) {
      sidSchema.parse(id);
      if (!service) problem("Le service d’appel est indisponible.");
      // call_legs is deliberately server-only. Authorize the resolved call below.
      const leg = checked(await service!.from("call_legs").select("call_id").eq("provider_call_sid", id).maybeSingle());
      if (!leg) problem("Cet appel n’est pas encore disponible ou vous n’y avez pas accès.", 404);
      callId = leg!.call_id;
    } else uuid.parse(id);
    // The user client enforces existing call RLS, including revoked assignments.
    const call = checked(await context!.supabase.from("calls").select("id,status,ended_at,started_at,created_at").eq("id", callId).maybeSingle());
    if (!call) problem("Appel introuvable.", 404);
    return call!;
  }
  const running = (call: { status: string; ended_at: string | null }) => !call.ended_at && ["initiated", "ringing", "in-progress", "answered"].includes(call.status);
  async function readRow(callId: string): Promise<TranscriptRow | null> {
    if (!db) return null;
    let row = checked(await db.from("call_transcriptions").select("*").eq("call_id", callId).maybeSingle()) as TranscriptRow | null;
    if (row && ["starting", "live", "stopping"].includes(row.status) && Date.now() - Date.parse(row.updated_at) > 25_000) {
      const stale = checked(await db.from("call_transcriptions").update({ status: "error", error: "La transcription a été interrompue. Les phrases reçues sont conservées.", updated_at: new Date().toISOString() }).eq("id", row.id).eq("updated_at", row.updated_at).select("*").maybeSingle()) as TranscriptRow | null;
      if (stale) row = stale;
    }
    return row;
  }
  for (const bySid of [true, false]) {
    app.get(bySid ? "/v1/voice/calls/:id/transcription" : "/v1/calls/:id/transcription", async (request, reply) => {
      reply.header("cache-control", "no-store");
      const call = await authorizedCall(request, bySid);
      // Disabled installations need not have the migration yet.
      const row = db && config.TRANSCRIPTION_ENABLED ? await readRow(call.id) : null;
      return transcriptionResponseSchema.parse({ available, callId: call.id, callActive: running(call), transcript: publicTranscript(row) });
    });
  }
  app.post("/v1/voice/calls/:id/transcription", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const call = await authorizedCall(request, true);
    if (!available || !db || !provider) problem("La transcription n’est pas activée pour cet espace.");
    if (config.OPERATIONS_PAUSED) problem(config.OPERATIONS_PAUSE_MESSAGE);
    if (call.ended_at || !["in-progress", "answered"].includes(call.status)) problem("La transcription démarre pendant un appel connecté.", 409);
    const providerSid = (request.params as { id: string }).id;
    // Unique call_id is the distributed start lock, including retries after a lost HTTP response.
    const inserted = await db!.from("call_transcriptions").insert({ call_id: call.id, provider_call_sid: providerSid, started_by: request.context!.userId }).select("*").single();
    if (inserted.error && inserted.error.code !== "23505") problem("Impossible de préparer la transcription.");
    let row = inserted.data as TranscriptRow | null;
    if (row) {
      try {
        const stream = await provider!.calls(providerSid).streams.create({
          url: `${config.API_PUBLIC_URL.replace(/\/$/, "").replace(/^https:/, "wss:")}/webhooks/twilio/transcription/${row.id}`,
          name: `scribe-${row.id}`, track: "both_tracks",
          statusCallback: `${config.API_PUBLIC_URL.replace(/\/$/, "")}/webhooks/twilio/transcription/${row.id}/status`, statusCallbackMethod: "POST",
        });
        // The WebSocket start can win this race; only fill a still-empty stream SID.
        checked(await db!.from("call_transcriptions").update({ stream_sid: stream.sid }).eq("id", row.id).is("stream_sid", null));
      } catch {
        checked(await db!.from("call_transcriptions").update({ status: "error", error: "Le flux de transcription n’a pas pu démarrer. Votre appel continue.", updated_at: new Date().toISOString() }).eq("id", row.id).eq("status", "starting"));
      }
    }
    row = await readRow(call.id);
    return transcriptionResponseSchema.parse({ available, callId: call.id, callActive: running(call), transcript: publicTranscript(row) });
  });
  app.post("/v1/calls/:id/transcription/stop", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const call = await authorizedCall(request, false);
    if (!db || !provider) problem("La transcription est indisponible.");
    const row = await readRow(call.id);
    if (row && ["starting", "live", "stopping"].includes(row.status)) {
      checked(await db!.from("call_transcriptions").update({ status: "stopping" }).eq("id", row.id).in("status", ["starting", "live"]));
      try { await provider!.calls(row.provider_call_sid).streams(`scribe-${row.id}`).update({ status: "stopped" }); }
      catch { /* The owning worker also observes stopping on its next heartbeat. */ }
      await liveSessions.get(row.id)?.();
    }
    return transcriptionResponseSchema.parse({ available, callId: call.id, callActive: running(call), transcript: publicTranscript(await readRow(call.id)) });
  });

  app.post("/webhooks/twilio/transcription/:id/status", async (request, reply) => {
    if (!validateWebhook(request)) return reply.code(403).send();
    const body = request.body as Record<string, string>;
    if (!db || body.AccountSid !== config.TWILIO_ACCOUNT_SID) return reply.code(403).send();
    const id = uuid.parse((request.params as { id: string }).id);
    if (body.StreamEvent === "stream-error") {
      checked(await db.from("call_transcriptions").update({ status: "error", error: "Le flux audio de transcription a été interrompu.", updated_at: new Date().toISOString() }).eq("id", id).eq("provider_call_sid", body.CallSid ?? "").in("status", ["starting", "live", "stopping"]));
      await liveSessions.get(id)?.();
    }
    return reply.code(204).send();
  });

  app.register(async (scope) => {
    await scope.register(websocket, { options: { maxPayload: 32 * 1024 } });
    scope.get<{ Params: { id: string } }>("/webhooks/twilio/transcription/:id", {
      websocket: true,
      preValidation: async (request, reply) => {
        if (!available || !uuid.safeParse(request.params.id).success || !validateWebhook(request)) return reply.code(403).send();
      },
    }, (socket, request) => {
      const id = request.params.id;
      let bridge: ScribeBridge | null = null;
      let row: TranscriptRow | null = null;
      let starting = false, finishing = false, failed = false, dirty = false;
      let streamSid = "";
      const buffered: Record<string, unknown>[] = [];
      let writeChain = Promise.resolve();
      let tickBusy = false;
      const flush = () => {
        if (!bridge || !row || !dirty) return writeChain;
        dirty = false;
        const snapshot = JSON.parse(JSON.stringify(bridge.snapshot)) as TranscriptSnapshot;
        writeChain = writeChain.then(async () => {
          checked(await db!.from("call_transcriptions").update({ snapshot, updated_at: new Date().toISOString() }).eq("id", id).in("status", ["starting", "live", "stopping"]));
        }).catch(() => { failed = true; bridge?.dispose(); socket.close(); });
        return writeChain;
      };
      const finish = async () => {
        if (finishing) return;
        finishing = true;
        clearInterval(ticker); clearTimeout(deadline); clearTimeout(startDeadline);
        if (bridge) { await bridge.finish(); dirty = true; await flush(); }
        if (row) {
          await db!.from("call_transcriptions").update({ status: failed ? "error" : "completed", error: failed ? "La transcription a été interrompue. Les phrases reçues sont conservées." : null, updated_at: new Date().toISOString() }).eq("id", id).in("status", ["starting", "live", "stopping"]);
        }
        liveSessions.delete(id);
        socket.close();
      };
      const startDeadline = setTimeout(() => { failed = true; void finish(); }, 10_000);
      const deadline = setTimeout(() => { failed = true; void finish(); }, (config.MAX_ACTIVE_CALL_SECONDS + 20) * 1000);
      let heartbeat = 0;
      const ticker = setInterval(() => {
        if (!row || finishing || tickBusy) return;
        tickBusy = true;
        void (async () => {
          if (++heartbeat % 10 === 0) {
            const state = checked(await db!.from("call_transcriptions").select("status").eq("id", id).single());
            if (!state || state.status === "stopping" || state.status === "error") { failed ||= !state || state.status === "error"; await finish(); return; }
            dirty = true;
          }
          await flush();
        })().catch(() => { failed = true; void finish(); }).finally(() => { tickBusy = false; });
      }, 400);

      function media(event: Record<string, any>) {
        if (event.streamSid !== streamSid || !event.media) return;
        const { track, payload, timestamp, chunk } = event.media;
        if (typeof payload !== "string" || payload.length > 16000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || !Number.isFinite(Number(timestamp))) { failed = true; void finish(); return; }
        bridge?.audio(track, payload, Number(timestamp), Number(chunk));
      }
      // Attach synchronously: Twilio can send media while the DB claim is pending.
      socket.on("message", (raw) => {
        try {
          const event = JSON.parse(raw.toString());
          if (finishing) return;
          if (event.event === "start") {
            if (starting || row) { failed = true; void finish(); return; }
            starting = true;
            void (async () => {
              const start = event.start;
              if (!start || start.accountSid !== config.TWILIO_ACCOUNT_SID || start.mediaFormat?.encoding !== "audio/x-mulaw" || start.mediaFormat?.sampleRate !== 8000 || start.mediaFormat?.channels !== 1 || !/^MZ[0-9a-fA-F]{32}$/.test(start.streamSid)) throw new Error("Invalid stream");
              row = checked(await db!.from("call_transcriptions").select("*").eq("id", id).eq("provider_call_sid", start.callSid).eq("status", "starting").maybeSingle()) as TranscriptRow | null;
              if (!row || (row.stream_sid && row.stream_sid !== start.streamSid)) throw new Error("Invalid session");
              // Claim the session across API instances, before opening paid provider sockets.
              const claimed = checked(await db!.from("call_transcriptions").update({ stream_connected: true, stream_sid: start.streamSid, updated_at: new Date().toISOString() }).eq("id", id).eq("status", "starting").eq("stream_connected", false).select("id").maybeSingle());
              if (!claimed) { row = null; throw new Error("Session already claimed"); }
              if (finishing) { await db!.from("call_transcriptions").update({ status: "error", error: "Connexion audio interrompue." }).eq("id", id); return; }
              streamSid = start.streamSid;
              const call = checked(await db!.from("calls").select("started_at,created_at,ended_at").eq("id", row.call_id).single());
              if (!call || call.ended_at) throw new Error("Call ended");
              bridge = new ScribeBridge({ key: config.ELEVENLABS_API_KEY!, ...(config.ELEVENLABS_LANGUAGE_CODE ? { language: config.ELEVENLABS_LANGUAGE_CODE } : {}), offsetMs: Math.max(0, Date.now() - Date.parse(call.started_at ?? call.created_at)), ...(openSocket ? { openSocket } : {}),
                onChange: () => { dirty = true; }, onReady: () => {
                  dirty = true;
                  writeChain = writeChain.then(async () => { checked(await db!.from("call_transcriptions").update({ status: "live", updated_at: new Date().toISOString() }).eq("id", id).eq("status", "starting")); }).catch(() => { failed = true; void finish(); });
                },
                onError: () => { failed = true; void finish(); },
              });
              clearTimeout(startDeadline);
              liveSessions.set(id, finish);
              for (const queued of buffered.splice(0)) media(queued);
            })().catch(() => { failed = true; void finish(); });
          } else if (event.event === "media") {
            if (bridge) media(event);
            else if (starting && buffered.length < 300) buffered.push(event);
            else { failed = true; void finish(); }
          } else if (event.event === "stop") void finish();
        } catch { failed = true; void finish(); }
      });
      socket.on("close", () => { if (!finishing) { failed = true; void finish(); } });
      socket.on("error", () => { failed = true; void finish(); });
    });
  });
  app.addHook("preClose", async () => { await Promise.allSettled([...liveSessions.values()].map((close) => close())); });
}
