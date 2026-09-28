import { Ringtone } from "./ringtone.js";
import type { Call, Device } from "@twilio/voice-sdk";
import type { StartVoiceCall, VoiceClient, VoiceEvent } from "@onoff/voice-contract";

export type { VoiceEvent } from "@onoff/voice-contract";

export class TwilioWebVoiceClient implements VoiceClient {
  private readonly ringtone = new Ringtone();
  private device: Device | null = null;
  private activeCall: Call | null = null;
  private refreshToken: (() => Promise<string>) | null = null;
  private connectVersion = 0;
  private readonly dismissedIncoming = new Map<string, number>();
  private readonly listeners = new Set<(event: VoiceEvent) => void>();

  async register(token: string, refreshToken: () => Promise<string>): Promise<void> {
    await this.destroy();
    this.refreshToken = refreshToken;
    const { Device: TwilioDevice } = await import("@twilio/voice-sdk");
    const device = new TwilioDevice(token, { logLevel: "error" });
    this.device = device;
    device.audio?.incoming(false);
    this.ringtone.prepare();
    device.on("registered", () => this.emit({ type: "ready" }));
    device.on("unregistered", () => this.emit({ type: "unavailable", message: "La ligne n’est plus enregistrée." }));
    device.on("incoming", (call) => this.handleIncoming(call));
    device.on("tokenWillExpire", () => {
      void this.refreshToken?.().then((nextToken) => device.updateToken(nextToken)).catch(() => {
        this.emit({ type: "unavailable", message: "La session vocale a expiré. Réactivez la ligne." });
      });
    });
    device.on("error", (error) => this.emit({ type: "unavailable", message: error.message || "La connexion vocale a échoué." }));
    await device.register();
  }

  async startCall(call: StartVoiceCall): Promise<void> {
    if (!this.device || this.device.state !== "registered") throw new Error("Activez la ligne vocale avant d’appeler.");
    if (this.activeCall) throw new Error("Un appel est déjà en cours.");
    const device = this.device;
    const version = ++this.connectVersion;
    this.emit({ type: "connecting" });
    const activeCall = await device.connect({ params: { To: call.destination, CallIntentId: call.intentId } });
    if (version !== this.connectVersion || this.device !== device) {
      activeCall.disconnect();
      throw new Error("La préparation de l’appel a été annulée.");
    }
    this.bindCall(activeCall, false);
  }

  acceptCall(): void {
    this.ringtone.stop();
    this.activeCall?.accept();
  }

  rejectCall(): void {
    const call = this.activeCall;
    if (!call || call.status() !== "pending") return;
    const key = this.incomingKey(call);
    if (key) this.dismissedIncoming.set(key, Date.now());
    this.ringtone.stop();
    call.reject();
    // Twilio can deliver another invite for the same call before its rejection
    // has propagated. Reject any already queued on this Device as well.
    if (key) {
      for (const pending of [...(this.device?.calls ?? [])]) {
        if (pending !== call && this.incomingKey(pending) === key && pending.status() === "pending") pending.reject();
      }
    }
  }

  hangUp(): void {
    this.ringtone.stop();
    this.connectVersion += 1;
    this.activeCall?.disconnect();
    this.device?.disconnectAll();
  }

  setMuted(muted: boolean): void {
    this.activeCall?.mute(muted);
  }

  sendDigits(digits: string): void {
    this.activeCall?.sendDigits(digits);
  }

  subscribe(listener: (event: VoiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async destroy(): Promise<void> {
    this.ringtone.destroy();
    this.connectVersion += 1;
    const device = this.device;
    this.device = null;
    this.activeCall = null;
    this.refreshToken = null;
    this.dismissedIncoming.clear();
    if (device) {
      device.removeAllListeners();
      await device.destroy();
    }
  }

  private incomingKey(call: Call): string {
    return call.customParameters?.get("CallId") || call.parameters?.CallSid || "";
  }

  private handleIncoming(call: Call): void {
    const now = Date.now();
    for (const [key, dismissedAt] of this.dismissedIncoming) {
      if (now - dismissedAt > 120_000) this.dismissedIncoming.delete(key);
    }
    // The SDK emits "incoming" only after starting its ringtone. An invite can
    // have been rejected or cancelled during that asynchronous startup.
    if (call.status() !== "pending") return;
    if (this.activeCall === call) return;
    const key = this.incomingKey(call);
    if ((key && this.dismissedIncoming.has(key)) || this.activeCall) {
      call.reject();
      return;
    }
    this.bindCall(call, true);
    this.ringtone.play("incoming");
    this.emit({ type: "incoming", from: call.parameters.From ?? "Numéro masqué" });
  }

  private bindCall(call: Call, incoming: boolean): void {
    this.activeCall = call;
    const emit = (event: VoiceEvent) => { if (this.activeCall === call) this.emit(event); };
    const emitActive = () => {
      if (this.activeCall === call) this.ringtone.stop();
      const providerCallSid = call.parameters?.CallSid;
      emit({ type: "active", ...(providerCallSid ? { providerCallSid } : {}) });
    };
    call.on("accept", emitActive);
    call.on("ringing", (hasEarlyMedia: boolean) => {
      if (this.activeCall !== call) return;
      if (!incoming && !hasEarlyMedia) this.ringtone.play("outgoing");
      else if (!incoming) this.ringtone.stop();
      emit({ type: "ringing" });
    });
    call.on("mute", (muted) => emit({ type: "muted", muted }));
    call.on("reconnecting", () => emit({ type: "reconnecting" }));
    call.on("reconnected", () => emit({ type: "reconnected" }));
    call.on("disconnect", () => this.finish(call, "completed"));
    call.on("cancel", () => this.finish(call, incoming ? "missed" : "canceled"));
    call.on("reject", () => this.finish(call, "rejected"));
    call.on("error", () => this.finish(call, "failed"));
    // connect() can resolve after a fast SDK transition. Read its actual state.
    if (!incoming && call.status() === "open") emitActive();
    else if (!incoming && call.status() === "ringing") emit({ type: "ringing" });
  }

  private finish(call: Call, reason: Extract<VoiceEvent, { type: "ended" }> ["reason"]): void {
    if (this.activeCall !== call) return;
    this.ringtone.stop();
    this.activeCall = null;
    this.emit({ type: "ended", reason });
  }

  private emit(event: VoiceEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export function createVoiceClient(): VoiceClient {
  return new TwilioWebVoiceClient();
}
