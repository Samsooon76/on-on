import type { Call, Device } from "@twilio/voice-sdk";
import type { StartVoiceCall, VoiceClient, VoiceEvent } from "@onoff/voice-contract";

export type { VoiceEvent } from "@onoff/voice-contract";

export class TwilioWebVoiceClient implements VoiceClient {
  private device: Device | null = null;
  private activeCall: Call | null = null;
  private refreshToken: (() => Promise<string>) | null = null;
  private connectVersion = 0;
  private readonly listeners = new Set<(event: VoiceEvent) => void>();

  async register(token: string, refreshToken: () => Promise<string>): Promise<void> {
    await this.destroy();
    this.refreshToken = refreshToken;
    const { Device: TwilioDevice } = await import("@twilio/voice-sdk");
    const device = new TwilioDevice(token, { logLevel: "error" });
    this.device = device;
    device.on("registered", () => this.emit({ type: "ready" }));
    device.on("unregistered", () => this.emit({ type: "unavailable", message: "La ligne n’est plus enregistrée." }));
    device.on("incoming", (call) => {
      this.bindCall(call, true);
      this.emit({ type: "incoming", from: call.parameters.From ?? "Numéro masqué" });
    });
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
    this.activeCall?.accept();
  }

  rejectCall(): void {
    this.activeCall?.reject();
  }

  hangUp(): void {
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
    this.connectVersion += 1;
    const device = this.device;
    this.device = null;
    this.activeCall = null;
    this.refreshToken = null;
    if (device) {
      device.removeAllListeners();
      await device.destroy();
    }
  }

  private bindCall(call: Call, incoming: boolean): void {
    this.activeCall = call;
    const emit = (event: VoiceEvent) => { if (this.activeCall === call) this.emit(event); };
    call.on("accept", () => emit({ type: "active" }));
    call.on("ringing", () => emit({ type: "ringing" }));
    call.on("mute", (muted) => emit({ type: "muted", muted }));
    call.on("reconnecting", () => emit({ type: "reconnecting" }));
    call.on("reconnected", () => emit({ type: "reconnected" }));
    call.on("disconnect", () => this.finish(call, "completed"));
    call.on("cancel", () => this.finish(call, incoming ? "missed" : "canceled"));
    call.on("reject", () => this.finish(call, "rejected"));
    call.on("error", () => this.finish(call, "failed"));
    // connect() can resolve after a fast SDK transition. Read its actual state.
    if (!incoming && call.status() === "open") emit({ type: "active" });
    else if (!incoming && call.status() === "ringing") emit({ type: "ringing" });
  }

  private finish(call: Call, reason: Extract<VoiceEvent, { type: "ended" }> ["reason"]): void {
    if (this.activeCall !== call) return;
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
