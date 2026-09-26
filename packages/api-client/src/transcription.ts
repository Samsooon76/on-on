import { transcriptionResponseSchema, type CallTranscript, type TranscriptSegment, type TranscriptionResponse } from "@onoff/contracts";
export type { CallTranscript, TranscriptSegment, TranscriptionResponse } from "@onoff/contracts";

export type TranscriptApi = <T>(path: string, init?: RequestInit) => Promise<T>;
export type TranscriptTarget = { providerCallSid: string; callId?: never } | { callId: string; providerCallSid?: never };
export const transcriptPath = (target: TranscriptTarget): string => target.providerCallSid
  ? `/v1/voice/calls/${encodeURIComponent(target.providerCallSid)}/transcription`
  : `/v1/calls/${encodeURIComponent(target.callId!)}/transcription`;
export const transcriptTime = (ms: number): string => `${Math.floor(ms / 60000).toString().padStart(2, "0")}:${Math.floor(ms / 1000 % 60).toString().padStart(2, "0")}`;
export const transcriptRows = (transcript: CallTranscript): (TranscriptSegment & { partial: boolean })[] => [
  ...transcript.segments.map((segment) => ({ ...segment, partial: false })),
  ...Object.values(transcript.partials).filter((segment): segment is TranscriptSegment => Boolean(segment)).map((segment) => ({ ...segment, partial: true })),
].sort((a, b) => a.offsetMs - b.offsetMs || a.id.localeCompare(b.id));
export function transcriptText(transcript: CallTranscript, remoteName = "Interlocuteur"): string {
  return transcriptRows(transcript).filter((row) => !row.partial).map((row) => `[${transcriptTime(row.offsetMs)}] ${row.speaker === "local" ? "Vous" : remoteName} : ${row.text}`).join("\n\n");
}
export const transcriptStatus = { starting: "Connexion…", live: "En direct", stopping: "Finalisation…", completed: "Transcription terminée", error: "Transcription interrompue" } as const;

/** Authenticated snapshots work across API replicas and on native iOS fetch.
 * Only one request at a time; abort and discard stale results on scope changes. */
export function watchTranscript(api: TranscriptApi, target: TranscriptTarget, listeners: {
  onData(data: TranscriptionResponse): void;
  onError(message: string, accessLost: boolean): void;
}, intervalMs = 800): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  async function poll() {
    try {
      const result = transcriptionResponseSchema.parse(await api(transcriptPath(target), { signal: controller.signal }));
      if (controller.signal.aborted) return;
      failures = 0;
      listeners.onData(result);
      if (result.transcript && ["completed", "error"].includes(result.transcript.status)) return;
      if (!result.callActive && !result.transcript || !result.available && !result.transcript) return;
    } catch (error) {
      if (controller.signal.aborted) return;
      failures++;
      const status = error && typeof error === "object" && "status" in error ? error.status : 0;
      const accessLost = status === 401 || status === 403 || status === 404;
      listeners.onError(error instanceof Error ? error.message : "Impossible d’actualiser la transcription.", accessLost);
      if (status === 401 || status === 403 || (status === 404 && failures >= 5)) return;
    }
    if (!controller.signal.aborted) timer = setTimeout(() => void poll(), failures ? Math.min(8000, intervalMs * 2 ** failures) : intervalMs);
  }
  void poll();
  return () => { controller.abort(); clearTimeout(timer); };
}
