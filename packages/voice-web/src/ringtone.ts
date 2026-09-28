/** Local tones: no remote audio download, and unlock audio on user interaction. */
export class Ringtone {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private mode: "incoming" | "outgoing" | null = null;
  private listening = false;

  private unlock = (): void => {
    try {
      this.context ??= new AudioContext();
      void this.context.resume().catch(() => undefined);
    } catch { /* Audio may be unavailable in this browser. */ }
  };

  prepare(): void {
    if (typeof window === "undefined" || this.listening) return;
    this.listening = true;
    window.addEventListener("pointerdown", this.unlock);
    window.addEventListener("keydown", this.unlock);
    this.unlock();
  }

  play(mode: "incoming" | "outgoing"): void {
    if (this.mode === mode) return;
    this.stop();
    this.prepare();
    const context = this.context;
    if (!context) return;
    void context.resume().catch(() => undefined);
    this.mode = mode;
    const buffer = context.createBuffer(1, context.sampleRate * 4, context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      const t = i / context.sampleRate;
      const start = mode === "incoming" && t >= 0.6 ? 0.6 : 0;
      const duration = mode === "incoming" ? 0.4 : 1.5;
      const phase = t - start;
      if (phase < 0 || phase >= duration) continue;
      const envelope = Math.min(1, phase / 0.015, (duration - phase) / 0.015);
      samples[i] = envelope * (mode === "incoming"
        ? 0.18 * (Math.sin(2 * Math.PI * 660 * t) + Math.sin(2 * Math.PI * 880 * t))
        : 0.2 * Math.sin(2 * Math.PI * 440 * t));
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(context.destination);
    source.start();
    this.source = source;
  }

  stop(): void {
    this.source?.stop();
    this.source?.disconnect();
    this.source = null;
    this.mode = null;
  }

  destroy(): void {
    this.stop();
    if (typeof window !== "undefined") {
      window.removeEventListener("pointerdown", this.unlock);
      window.removeEventListener("keydown", this.unlock);
    }
    this.listening = false;
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }
}
