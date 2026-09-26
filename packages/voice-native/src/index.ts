import { AudioDevice, Call, CallInvite, Voice } from "@twilio/voice-react-native-sdk";
import type { StartVoiceCall, VoiceClient, VoiceEvent } from "@onoff/voice-contract";

export type NativeAudioRoute = { id: string; name: string; type: string };
export type NativeAudioRouteSnapshot = { devices: NativeAudioRoute[]; selectedId?: string };

export interface NativeVoiceClient extends VoiceClient {
  setAccessToken(token: string): void;
  unregister(token?: string): Promise<void>;
  restoreCallState(): Promise<void>;
  getAudioRouteSnapshot(): Promise<NativeAudioRouteSnapshot>;
  selectNextAudioRoute(): Promise<void>;
  showAudioRoutePicker(): Promise<void>;
  setAudioRouteListener(listener: (snapshot: NativeAudioRouteSnapshot) => void): void;
}

export class TwilioNativeVoiceClient implements NativeVoiceClient {
  private readonly voice = new Voice();
  private readonly listeners = new Set<(event: VoiceEvent) => void>();
  private accessToken = "";
  private activeCall: Call | null = null;
  private pendingInvite: CallInvite | null = null;
  private audioRouteListener: ((snapshot: NativeAudioRouteSnapshot) => void) | null = null;

  constructor(private readonly platform: "ios" | "android") {
    if (platform === "ios") {
      void this.voice.initializePushRegistry().catch((error: unknown) => {
        this.emit({ type: "unavailable", message: getMessage(error) });
      });
    }

    this.voice.on(Voice.Event.CallInvite, (invite) => this.bindInvite(invite as unknown as CallInvite));
    this.voice.on(Voice.Event.Registered, () => this.emit({ type: "ready" }));
    this.voice.on(Voice.Event.Unregistered, () => this.emit({ type: "unavailable", message: "Réception des appels désactivée." }));
    this.voice.on(Voice.Event.AudioDevicesUpdated, (devices, selectedDevice) => {
      this.audioRouteListener?.(toSnapshot(devices, selectedDevice));
    });
    this.voice.on(Voice.Event.Error, (error) => this.emit({ type: "unavailable", message: error.message || "La session vocale a échoué." }));
  }

  async register(token: string, _refreshToken: () => Promise<string>): Promise<void> {
    this.accessToken = token;
    await this.voice.register(token);
  }

  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  async unregister(token = this.accessToken): Promise<void> {
    if (!token) return;
    await this.voice.unregister(token);
    if (this.accessToken === token) this.accessToken = "";
  }

  async startCall(call: StartVoiceCall): Promise<void> {
    if (!this.accessToken) throw new Error("La session vocale est indisponible. Réactivez la ligne.");
    this.emit({ type: "connecting" });
    const activeCall = await this.voice.connect(this.accessToken, {
      contactHandle: call.destination,
      notificationDisplayName: "Onoff",
      params: { To: call.destination, CallIntentId: call.intentId },
    });
    this.bindCall(activeCall);
  }

  acceptCall(): void {
    void this.pendingInvite?.accept().catch((error: unknown) => this.emit({ type: "unavailable", message: getMessage(error) }));
  }

  rejectCall(): void {
    void this.pendingInvite?.reject().catch((error: unknown) => this.emit({ type: "unavailable", message: getMessage(error) }));
    this.pendingInvite = null;
  }

  hangUp(): void {
    this.activeCall?.disconnect();
    this.rejectCall();
  }

  setMuted(muted: boolean): void {
    this.activeCall?.mute(muted);
    this.emit({ type: "muted", muted });
  }

  sendDigits(digits: string): void {
    void this.activeCall?.sendDigits(digits).catch((error: unknown) => this.emit({ type: "unavailable", message: getMessage(error) }));
  }

  async getAudioRouteSnapshot(): Promise<NativeAudioRouteSnapshot> {
    const { audioDevices, selectedDevice } = await this.voice.getAudioDevices();
    return toSnapshot(audioDevices, selectedDevice);
  }

  async selectNextAudioRoute(): Promise<void> {
    const snapshot = await this.getAudioRouteSnapshot();
    if (!snapshot.devices.length) return;
    const currentIndex = snapshot.devices.findIndex((device) => device.id === snapshot.selectedId);
    const next = snapshot.devices[(currentIndex + 1) % snapshot.devices.length];
    const { audioDevices } = await this.voice.getAudioDevices();
    const selected = audioDevices.find((device) => device.uuid === next?.id);
    if (selected) await selected.select();
  }

  async showAudioRoutePicker(): Promise<void> {
    if (this.platform === "ios") await this.voice.showAvRoutePickerView();
  }

  setAudioRouteListener(listener: (snapshot: NativeAudioRouteSnapshot) => void): void {
    this.audioRouteListener = listener;
    void this.getAudioRouteSnapshot().then(listener).catch((error: unknown) => this.emit({ type: "unavailable", message: getMessage(error) }));
  }

  async restoreCallState(): Promise<void> {
    const calls = await this.voice.getCalls();
    const call = calls.values().next().value;
    if (call && !this.activeCall) {
      this.bindCall(call);
      return;
    }
    const invites = await this.voice.getCallInvites();
    const invite = invites.values().next().value;
    if (invite && !this.pendingInvite && !this.activeCall) this.bindInvite(invite);
  }

  subscribe(listener: (event: VoiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async destroy(): Promise<void> {
    this.listeners.clear();
    this.audioRouteListener = null;
    this.activeCall = null;
    this.pendingInvite = null;
    this.accessToken = "";
    this.voice.removeAllListeners();
  }

  private bindInvite(invite: CallInvite): void {
    if (this.pendingInvite?.getCallSid() === invite.getCallSid()) return;
    this.pendingInvite = invite;
    this.emit({ type: "incoming", from: invite.getFrom() || "Numéro masqué" });
    invite.on(CallInvite.Event.Accepted, (call) => {
      this.pendingInvite = null;
      this.bindCall(call);
    });
    invite.on(CallInvite.Event.Cancelled, () => {
      this.pendingInvite = null;
      this.emit({ type: "ended", reason: "missed" });
    });
    invite.on(CallInvite.Event.Rejected, () => {
      this.pendingInvite = null;
      this.emit({ type: "ended", reason: "rejected" });
    });
  }

  private bindCall(call: Call): void {
    if (this.activeCall?.getSid() === call.getSid()) return;
    this.activeCall = call;
    const state = call.getState();
    if (state === Call.State.Connected) this.emit({ type: "active", ...(call.getSid() ? { providerCallSid: call.getSid()! } : {}) });
    else if (state === Call.State.Reconnecting) this.emit({ type: "reconnecting" });
    else if (state === Call.State.Connecting) this.emit({ type: "connecting" });
    else this.emit({ type: "ringing" });
    call.on(Call.Event.Connected, () => this.emit({ type: "active", ...(call.getSid() ? { providerCallSid: call.getSid()! } : {}) }));
    call.on(Call.Event.Ringing, () => this.emit({ type: "ringing" }));
    call.on(Call.Event.Reconnecting, () => this.emit({ type: "reconnecting" }));
    call.on(Call.Event.Reconnected, () => this.emit({ type: "reconnected" }));
    call.on(Call.Event.Disconnected, (error) => this.finish(error ? "failed" : "completed"));
    call.on(Call.Event.ConnectFailure, () => this.finish("failed"));
  }

  private finish(reason: Extract<VoiceEvent, { type: "ended" }> ["reason"]): void {
    this.activeCall = null;
    this.pendingInvite = null;
    this.emit({ type: "ended", reason });
  }

  private emit(event: VoiceEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export function createNativeVoiceClient(platform: "ios" | "android"): NativeVoiceClient {
  return new TwilioNativeVoiceClient(platform);
}

function toSnapshot(audioDevices: AudioDevice[], selectedDevice?: AudioDevice): NativeAudioRouteSnapshot {
  return {
    devices: audioDevices.map((device) => ({ id: device.uuid, name: device.name, type: device.type })),
    ...(selectedDevice ? { selectedId: selectedDevice.uuid } : {}),
  };
}

function getMessage(error: unknown): string {
  return error instanceof Error ? error.message : "La session vocale a échoué.";
}
