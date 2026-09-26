import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { TranscriptSegment } from "@onoff/contracts";

type Speaker = "local" | "remote";
export type TranscriptSnapshot = { segments: TranscriptSegment[]; partials: Record<Speaker, TranscriptSegment | null> };
export type ScribeSocketFactory = (url: string, key: string) => WebSocket;
export const openScribeSocket: ScribeSocketFactory = (url, key) => new WebSocket(url, {
  headers: { "xi-api-key": key }, handshakeTimeout: 8000, maxPayload: 256 * 1024,
});

export function scribeUrl(language?: string): string {
  const url = new URL("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
  url.searchParams.set("model_id", "scribe_v2_realtime");
  url.searchParams.set("audio_format", "ulaw_8000");
  url.searchParams.set("commit_strategy", "vad");
  url.searchParams.set("vad_silence_threshold_secs", "0.7");
  if (language) url.searchParams.set("language_code", language);
  return url.toString();
}

/** A separate Scribe session per SDK-leg track gives deterministic speaker labels.
 * No microphone capture, mixing, resampling or audio storage is needed. */
export class ScribeBridge {
  readonly snapshot: TranscriptSnapshot = { segments: [], partials: { local: null, remote: null } };
  private channels = new Map<Speaker, { socket: WebSocket; ready: boolean; queue: string[]; offset: number; segmentOffset: number; lastChunk: number; bytes: number; pending: boolean }>();
  private closed = false;
  private finishing = false;
  private endTimer?: ReturnType<typeof setTimeout>;
  private readyTimer: ReturnType<typeof setTimeout>;
  private resolveFinish?: () => void;
  private finishPromise?: Promise<void>;

  constructor(private options: {
    key: string; language?: string; offsetMs: number;
    openSocket?: ScribeSocketFactory;
    onChange(snapshot: TranscriptSnapshot): void;
    onReady(): void;
    onError(message: string): void;
  }) {
    this.readyTimer = setTimeout(() => this.fail("La connexion à la transcription a expiré."), 10_000);
    for (const speaker of ["local", "remote"] as const) {
      const socket = (options.openSocket ?? openScribeSocket)(scribeUrl(options.language), options.key);
      const channel = { socket, ready: false, queue: [] as string[], offset: options.offsetMs, segmentOffset: options.offsetMs, lastChunk: 0, bytes: 0, pending: false };
      this.channels.set(speaker, channel);
      socket.on("message", (raw) => {
        if (this.closed) return;
        try {
          const event = JSON.parse(raw.toString());
          if (event.message_type === "session_started") {
            channel.ready = true;
            for (const payload of channel.queue.splice(0)) socket.send(payload);
            if ([...this.channels.values()].every((item) => item.ready)) { clearTimeout(this.readyTimer); options.onReady(); }
          } else if (event.message_type === "partial_transcript" && typeof event.text === "string") {
            const previous = this.snapshot.partials[speaker];
            if (!previous) channel.segmentOffset = channel.offset;
            this.snapshot.partials[speaker] = event.text.trim() ? { id: previous?.id ?? randomUUID(), speaker, text: event.text.slice(0, 16000), offsetMs: channel.segmentOffset } : null;
            options.onChange(this.snapshot);
          } else if (event.message_type === "committed_transcript" && typeof event.text === "string") {
            const partial = this.snapshot.partials[speaker];
            if (event.text.trim()) this.snapshot.segments.push({ id: partial?.id ?? randomUUID(), speaker, text: event.text.slice(0, 16000), offsetMs: partial?.offsetMs ?? channel.segmentOffset });
            this.snapshot.partials[speaker] = null;
            channel.segmentOffset = channel.offset;
            channel.bytes = 0;
            channel.pending = false;
            options.onChange(this.snapshot);
            if (this.finishing && [...this.channels.values()].every((item) => !item.pending)) this.dispose();
          } else if (event.error || /error|exceeded|rate_limited|unaccepted_terms/.test(String(event.message_type))) {
            // Provider messages can include sensitive input; never persist or log them.
            this.fail("Le service de transcription est indisponible. Votre appel continue.");
          }
          // Timestamp events are additional to commits, never another segment.
        } catch { this.fail("Le service de transcription a renvoyé une réponse invalide."); }
      });
      socket.on("error", () => this.fail("La connexion à la transcription a été interrompue. Votre appel continue."));
      socket.on("close", () => { if (!this.closed) this.fail("La transcription a été interrompue. Les phrases reçues sont conservées."); });
    }
  }

  audio(track: string, payload: string, timestamp: number, chunk: number): void {
    if (this.closed || this.finishing) return;
    const speaker = track === "inbound" ? "local" : track === "outbound" ? "remote" : null;
    if (!speaker) return;
    const channel = this.channels.get(speaker)!;
    if (!Number.isFinite(chunk) || chunk <= channel.lastChunk) return;
    channel.lastChunk = chunk;
    channel.offset = this.options.offsetMs + Math.max(0, timestamp);
    channel.bytes += Buffer.byteLength(payload, "base64");
    const message = JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: payload, sample_rate: 8000 });
    if (channel.socket.bufferedAmount > 256 * 1024 || channel.queue.length >= 250) {
      this.fail("La connexion est trop lente pour poursuivre la transcription. Votre appel continue.");
    } else if (channel.ready && channel.socket.readyState === WebSocket.OPEN) channel.socket.send(message);
    else channel.queue.push(message);
  }

  finish(): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    if (this.closed) return Promise.resolve();
    this.finishing = true;
    this.finishPromise = new Promise((resolve) => { this.resolveFinish = resolve; });
    // Manual commits work with VAD too. Pad with μ-law silence for short tails.
    for (const channel of this.channels.values()) {
      channel.pending = channel.ready && channel.bytes > 0;
      if (channel.pending && channel.socket.readyState === WebSocket.OPEN) {
        channel.socket.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: Buffer.alloc(8000, 0xff).toString("base64"), sample_rate: 8000, commit: true }));
      }
    }
    if ([...this.channels.values()].every((item) => !item.pending)) this.dispose();
    else this.endTimer = setTimeout(() => {
      if (Object.values(this.snapshot.partials).some(Boolean)) this.fail("La dernière phrase n’a pas pu être finalisée. Les phrases précédentes sont conservées.");
      else this.dispose();
    }, 3500);
    return this.finishPromise;
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.options.onError(message);
    this.dispose();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.readyTimer);
    clearTimeout(this.endTimer);
    for (const channel of this.channels.values()) {
      channel.queue.length = 0;
      channel.socket.close();
    }
    this.resolveFinish?.();
  }
}
