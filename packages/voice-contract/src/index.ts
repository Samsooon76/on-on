export type VoiceEvent =
  | { type: "ready" }
  | { type: "unavailable"; message: string }
  | { type: "incoming"; from: string }
  | { type: "connecting" }
  | { type: "ringing" }
  | { type: "active"; providerCallSid?: string }
  | { type: "reconnecting" }
  | { type: "reconnected" }
  | { type: "ended"; reason: "completed" | "missed" | "rejected" | "canceled" | "failed" }
  | { type: "muted"; muted: boolean };

export type StartVoiceCall = {
  destination: string;
  intentId: string;
};

export interface VoiceClient {
  register(token: string, refreshToken: () => Promise<string>): Promise<void>;
  startCall(call: StartVoiceCall): Promise<void>;
  acceptCall(): void;
  rejectCall(): void;
  hangUp(): void;
  setMuted(muted: boolean): void;
  sendDigits(digits: string): void;
  subscribe(listener: (event: VoiceEvent) => void): () => void;
  destroy(): Promise<void>;
}
