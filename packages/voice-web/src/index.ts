import type { Call, Device } from "@twilio/voice-sdk";
import type { StartVoiceCall, VoiceClient, VoiceEvent } from "@onoff/voice-contract";

export type { VoiceEvent } from "@onoff/voice-contract";

export class TwilioWebVoiceClient implements VoiceClient {
  private device: Device | null = null;
  private activeCall: Call | null = null;
  private refreshToken: (() => Promise<string>) | null = null;
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
    this.emit({ type: "connecting" });
    const activeCall = await this.device.connect({ params: { To: call.destination, CallIntentId: call.intentId } });
    this.bindCall(activeCall, false);
  }

  acceptCall(): void {
    this.activeCall?.accept();
  }

  rejectCall(): void {
    this.activeCall?.reject();
  }

  hangUp(): void {
    this.activeCall?.disconnect();
    this.device?.disconnectAll();
  }

  setMuted(muted: boolean): void {
    this.activeCall?.mute(muted);
    this.emit({ type: "muted", muted });
  }

  sendDigits(digits: string): void {
    this.activeCall?.sendDigits(digits);
  }

  subscribe(listener: (event: VoiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async destroy(): Promise<void> {
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
    if (!incoming) this.emit({ type: "ringing" });
    call.on("accept", () => this.emit({ type: "active" }));
    call.on("ringing", () => this.emit({ type: "ringing" }));
    call.on("mute", (muted) => this.emit({ type: "muted", muted }));
    call.on("disconnect", () => this.finish("completed"));
    call.on("cancel", () => this.finish(incoming ? "missed" : "canceled"));
    call.on("reject", () => this.finish("rejected"));
    call.on("error", () => this.finish("failed"));
  }

  private finish(reason: Extract<VoiceEvent, { type: "ended" }> ["reason"]): void {
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
