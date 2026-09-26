import { Readable, Transform } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallRecording } from "@onoff/contracts";
import type { AppConfig } from "./config.js";
import type { CenterProvider } from "./call-center-provider.js";

export type RecordingFields = {
  recording_sid: string | null;
  recording_stop_requested: boolean;
  recording_status: CallRecording["status"] | null;
  recording_duration_seconds: number | null;
  recording_started_at: string | null;
  recording_updated_at: string | null;
  recording_error: string | null;
};
type RecordingRow = RecordingFields & { id: string; call_id: string; provider_call_sid: string };
const pending = ["starting", "recording", "processing"];
const fail = (message: string, statusCode = 503): never => { throw Object.assign(new Error(message), { statusCode }); };
function checked<T>(result: { data: T; error: unknown }): T { if (result.error) fail("L’enregistrement est momentanément indisponible."); return result.data; }
export function publicRecording(row: RecordingFields): CallRecording | null {
  return row.recording_status ? { status: row.recording_status, durationSeconds: row.recording_duration_seconds ?? null, startedAt: row.recording_started_at ?? null, error: row.recording_error ?? null } : null;
}
function state(status: string): CallRecording["status"] {
  return status === "completed" ? "ready" : status === "absent" ? "unavailable" : status === "in-progress" || status === "paused" ? "recording" : "processing";
}

export function registerCallRecording(app: FastifyInstance, config: AppConfig, db: SupabaseClient | null, provider: CenterProvider | null,
  validate: (request: FastifyRequest) => boolean, authorize: (request: FastifyRequest) => Promise<{ id: string }>) {
  const patch = async (id: string, values: Partial<RecordingFields>, statuses = pending) => {
    if (!db) return;
    checked(await db.from("call_transcriptions").update({ ...values, recording_updated_at: new Date().toISOString() }).eq("id", id).in("recording_status", statuses));
  };
  async function start(row: RecordingRow) {
    if (!config.CALL_RECORDING_ENABLED || !db || !provider) return;
    try {
      const recording = await provider.calls(row.provider_call_sid).recordings.create({
        recordingChannels: "dual", recordingTrack: "both", trim: "do-not-trim",
        recordingStatusCallback: `${config.API_PUBLIC_URL.replace(/\/$/, "")}/webhooks/twilio/transcription/${row.id}/recording`,
        recordingStatusCallbackMethod: "POST", recordingStatusCallbackEvent: ["in-progress", "completed", "absent"],
      });
      // Callback delivery may precede this response. Never downgrade a terminal status.
      checked(await db.from("call_transcriptions").update({ recording_sid: recording.sid }).eq("id", row.id).is("recording_sid", null));
      await patch(row.id, { recording_status: state(recording.status) }, ["starting"]);
      const current = checked(await db.from("call_transcriptions").select("*").eq("id", row.id).single()) as RecordingRow;
      if (current.recording_stop_requested) await stop(current);
    } catch {
      await patch(row.id, { recording_status: "failed", recording_error: "L’enregistrement audio n’a pas pu démarrer. La transcription peut continuer." }, ["starting"]);
    }
  }
  async function stop(row: RecordingRow) {
    if (!db || !provider || !row.recording_status || !["starting", "recording"].includes(row.recording_status)) return;
    await patch(row.id, { recording_stop_requested: true }, ["starting", "recording"]);
    if (!row.recording_sid) return; // start response / signed callback will complete the stop.
    try {
      await provider.calls(row.provider_call_sid).recordings(row.recording_sid).update({ status: "stopped" });
      await patch(row.id, { recording_status: "processing" }, ["starting", "recording"]);
    } catch { fail("L’arrêt de l’enregistrement n’a pas été confirmé. Réessayez ou terminez l’appel."); }
  }
  async function refresh<T extends RecordingRow>(row: T): Promise<T> {
    if (!db || !provider || !row.recording_status || !pending.includes(row.recording_status) || !row.recording_updated_at || Date.now() - Date.parse(row.recording_updated_at) < 8000) return row;
    const now = new Date().toISOString();
    const claim = checked(await db.from("call_transcriptions").update({ recording_updated_at: now }).eq("id", row.id).eq("recording_updated_at", row.recording_updated_at).in("recording_status", pending).select("id").maybeSingle());
    if (!claim) return row;
    if (row.recording_sid) {
      try {
        if (row.recording_stop_requested && row.recording_status === "recording") await stop(row);
        const recording = await provider.calls(row.provider_call_sid).recordings(row.recording_sid).fetch();
        const duration = Number(recording.duration);
        await patch(row.id, { recording_status: state(recording.status), recording_duration_seconds: Number.isInteger(duration) && duration >= 0 ? duration : null, recording_error: recording.status === "absent" ? "Aucun audio exploitable n’a été reçu." : null });
      } catch {
        // Do not turn a temporary provider/network failure into a permanent recording loss.
        if (Date.now() - Date.parse(row.recording_started_at ?? now) > (config.MAX_ACTIVE_CALL_SECONDS + 300) * 1000) await patch(row.id, { recording_status: "failed", recording_error: "La disponibilité de l’audio n’a pas pu être confirmée." });
      }
    } else if (Date.now() - Date.parse(row.recording_started_at ?? now) > 60_000) {
      await patch(row.id, { recording_status: "failed", recording_error: "Le démarrage de l’enregistrement n’a pas été confirmé." });
    }
    return checked(await db.from("call_transcriptions").select("*").eq("id", row.id).single()) as T;
  }

  app.post<{ Params: { id: string } }>("/webhooks/twilio/transcription/:id/recording", async (request, reply) => {
    if (!validate(request)) return reply.code(403).send();
    const body = request.body as Record<string, string>;
    if (!db || body.AccountSid !== config.TWILIO_ACCOUNT_SID) return reply.code(403).send();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.id) || !/^RE[0-9a-f]{32}$/i.test(body.RecordingSid ?? "") || !["in-progress", "completed", "absent"].includes(body.RecordingStatus ?? "")) return reply.code(400).send();
    const row = checked(await db.from("call_transcriptions").select("*").eq("id", request.params.id).eq("provider_call_sid", body.CallSid ?? "").maybeSingle()) as RecordingRow | null;
    if (!row?.recording_status || (row.recording_sid && row.recording_sid !== body.RecordingSid)) return reply.code(404).send();
    const duration = /^\d+$/.test(body.RecordingDuration ?? "") ? Number(body.RecordingDuration) : null;
    if (duration !== null && !Number.isSafeInteger(duration)) return reply.code(400).send();
    await patch(row.id, { recording_sid: body.RecordingSid!, recording_status: state(body.RecordingStatus!), recording_duration_seconds: duration,
      recording_error: body.RecordingStatus === "absent" ? "Aucun audio exploitable n’a été reçu." : null }, body.RecordingStatus === "in-progress" ? ["starting"] : [...pending, "failed"]);
    if (body.RecordingStatus === "in-progress" && row.recording_stop_requested && ["starting", "recording", "failed"].includes(row.recording_status)) await stop({ ...row, recording_sid: body.RecordingSid!, recording_status: "recording" });
    return reply.code(204).send();
  });

  app.get("/v1/calls/:id/recording/audio", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const call = await authorize(request);
    if (!db) fail("L’audio est indisponible.");
    const row = checked(await db!.from("call_transcriptions").select("recording_sid,recording_status").eq("call_id", call.id).maybeSingle()) as RecordingFields | null;
    if (!row?.recording_sid || row.recording_status !== "ready") fail("L’audio n’est pas encore disponible.", 404);
    const range = request.headers.range;
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return reply.code(416).send();
    // Never use RecordingUrl from a callback or redirect the client to Twilio.
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.TWILIO_ACCOUNT_SID}/Recordings/${row!.recording_sid}.mp3?RequestedChannels=1`, {
      headers: { authorization: `Basic ${Buffer.from(`${config.TWILIO_API_KEY_SID}:${config.TWILIO_API_KEY_SECRET}`).toString("base64")}`, ...(range ? { range } : {}) }, signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 416) { await response.body?.cancel(); return reply.code(416).send(); }
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 64 * 1024 * 1024) { await response.body?.cancel(); fail("L’enregistrement est indisponible pour le moment."); }
    reply.code(response.status === 206 ? 206 : 200).type("audio/mpeg").header("x-content-type-options", "nosniff");
    for (const header of ["content-length", "content-range", "accept-ranges"]) { const value = response.headers.get(header); if (value) reply.header(header, value); }
    reply.header("content-disposition", `inline; filename="appel-${call.id}.mp3"`);
    let bytes = 0;
    const source = Readable.fromWeb(response.body! as Parameters<typeof Readable.fromWeb>[0]);
    const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; callback(bytes > 64 * 1024 * 1024 ? new Error("Recording exceeds size limit") : null, chunk); } });
    source.on("error", (error) => limit.destroy(error));
    limit.on("close", () => source.destroy());
    reply.raw.once("close", () => { source.destroy(); limit.destroy(); });
    return reply.send(source.pipe(limit));
  });
  return { start, stop, refresh };
}
