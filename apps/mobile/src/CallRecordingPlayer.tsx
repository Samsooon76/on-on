import { useEffect, useState } from "react";
import { ActivityIndicator, AppState, StyleSheet, Text, View } from "react-native";
import { requireOptionalNativeModule } from "expo";
import { transcriptTime, type CallRecording } from "@onoff/api-client";
import { Icon, Touch, palette } from "./ui";

// Existing development builds remain usable until the native audio module is rebuilt.
const audioModule = requireOptionalNativeModule("ExpoAudio") ? require("expo-audio") as typeof import("expo-audio") : null;
export type CallAudioSource = (callId: string) => { uri: string; headers: Record<string, string> };
type Props = { callId: string; recording: CallRecording | null | undefined; getAudioSource: CallAudioSource; blocked: boolean };

export function CallRecordingPlayer(props: Props) {
  const recording = props.recording;
  if (recording?.status === "ready" && audioModule) return <ReadyPlayer {...props} />;
  const message = recording?.status === "ready" ? "Mettez à jour l’application pour écouter cet audio." : recording?.status === "starting" || recording?.status === "recording" ? "Enregistrement en cours · écoute après l’appel" : recording?.status === "processing" ? "Préparation de votre audio…" : recording?.error ?? "Aucun audio enregistré pour cet appel.";
  return <View style={s.container}><View style={s.heading}><Icon name="headset-outline" size={17} color={palette.accent} /><Text style={s.title}>Écouter l’appel</Text></View><View style={s.controls}><View style={[s.play, s.disabled]}><Icon name="play" color={palette.muted} size={22} /></View><View style={s.track}><View style={s.line} /><View style={s.times}><Text style={s.time}>00:00</Text><Text style={s.time}>{transcriptTime((recording?.durationSeconds ?? 0) * 1000)}</Text></View></View></View><Text accessibilityLiveRegion="polite" style={s.caption}>{message}</Text></View>;
}

function ReadyPlayer({ callId, recording, getAudioSource, blocked }: Props) {
  const player = audioModule!.useAudioPlayer(null, { updateInterval: 250 });
  const status = audioModule!.useAudioPlayerStatus(player);
  const [loaded, setLoaded] = useState(false), [waiting, setWaiting] = useState(false), [error, setError] = useState("");
  const [trackWidth, setTrackWidth] = useState(1), [rate, setRate] = useState(1);
  const total = status.duration || recording?.durationSeconds || 0;
  useEffect(() => { if (blocked) { player.pause(); setWaiting(false); } }, [blocked, player]);
  useEffect(() => { const listener = AppState.addEventListener("change", (state) => { if (state !== "active") { player.pause(); setWaiting(false); } }); return () => listener.remove(); }, [player]);
  useEffect(() => {
    if (waiting && status.isLoaded && !blocked) { player.setPlaybackRate(rate); player.play(); setWaiting(false); }
  }, [waiting, status.isLoaded, blocked, player, rate]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => { setWaiting(false); setLoaded(false); player.pause(); setError("Le chargement prend trop de temps. Réessayez."); }, 20_000);
    return () => clearTimeout(timer);
  }, [waiting, player]);
  useEffect(() => { if (status.error) { setError("Impossible de lire cet audio. Réessayez."); setWaiting(false); setLoaded(false); } }, [status.error]);
  async function toggle() {
    if (blocked) return;
    if (status.playing) { player.pause(); return; }
    setError("");
    try {
      await audioModule!.setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false, interruptionMode: "mixWithOthers" });
      if (!loaded) { player.replace(getAudioSource(callId)); setLoaded(true); setWaiting(true); return; }
      if (status.didJustFinish || total > 0 && status.currentTime >= total - 0.1) await player.seekTo(0);
      player.play();
    } catch { setWaiting(false); setLoaded(false); setError("Impossible de lire cet audio. Réessayez."); }
  }
  async function seek(seconds: number) { try { await player.seekTo(Math.max(0, Math.min(total, seconds))); } catch { setError("Ce passage n’est pas encore chargé."); } }
  return <View style={s.container}>
    <View style={s.heading}><Icon name="headset-outline" size={17} color={palette.accent} /><Text style={s.title}>Écouter l’appel</Text><Text style={s.tag}>Audio de l’appel</Text></View>
    <View style={s.controls}><Touch style={[s.play, blocked && s.disabled]} disabled={blocked || waiting} accessibilityLabel={status.playing ? "Mettre en pause" : "Écouter l’appel"} onPress={() => void toggle()}>{waiting || status.isBuffering ? <ActivityIndicator color={palette.white} /> : <Icon name={status.playing ? "pause" : "play"} size={22} color={palette.white} />}</Touch>
      <View style={s.track}><Touch style={s.seek} disabled={!status.isLoaded || blocked} onLayout={event => setTrackWidth(event.nativeEvent.layout.width)} onPress={event => void seek(event.nativeEvent.locationX / trackWidth * total)} accessibilityRole="adjustable" accessibilityLabel="Position dans l’enregistrement" accessibilityValue={{ min: 0, max: Math.max(1, total), now: Math.min(total, status.currentTime), text: transcriptTime(status.currentTime * 1000) }} accessibilityActions={[{ name: "increment", label: "Avancer de dix secondes" }, { name: "decrement", label: "Reculer de dix secondes" }]} onAccessibilityAction={event => void seek(status.currentTime + (event.nativeEvent.actionName === "increment" ? 10 : -10))}><View style={s.line}><View style={[s.progress, { width: `${Math.min(100, total ? status.currentTime / total * 100 : 0)}%` }]} /></View></Touch><View style={s.times}><Text style={s.time}>{transcriptTime(status.currentTime * 1000)}</Text><Text style={s.time}>{transcriptTime(total * 1000)}</Text></View></View>
      <Touch style={s.speed} disabled={blocked} accessibilityLabel={`Vitesse de lecture : ${rate} fois`} onPress={() => { const next = [1, 1.25, 1.5, 2][([1, 1.25, 1.5, 2].indexOf(rate) + 1) % 4]!; player.setPlaybackRate(next); setRate(next); }}><Text style={s.speedText}>{rate}×</Text></Touch>
    </View><Text accessibilityLiveRegion="polite" style={[s.caption, !!error && { color: palette.red }]}>{error || (blocked ? "L’écoute sera disponible après l’appel en cours." : waiting ? "Chargement de l’audio…" : "Les deux voix · depuis le démarrage de la transcription")}</Text>
  </View>;
}
const s = StyleSheet.create({
  container: { paddingHorizontal: 22, paddingVertical: 15, backgroundColor: "#F8FAF8", borderBottomWidth: 1, borderColor: palette.line },
  heading: { flexDirection: "row", alignItems: "center", gap: 7 }, title: { fontSize: 11, fontWeight: "600", color: palette.accent }, tag: { marginLeft: "auto", fontSize: 9, color: palette.muted },
  controls: { flexDirection: "row", alignItems: "center", gap: 13, marginTop: 13 }, play: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: palette.accent }, disabled: { backgroundColor: "#DFE7E0" }, track: { flex: 1 },
  seek: { minHeight: 30, justifyContent: "center" }, line: { height: 4, backgroundColor: "#DEE6DF", borderRadius: 3 }, progress: { height: 4, backgroundColor: palette.accent, borderRadius: 3 },
  times: { flexDirection: "row", justifyContent: "space-between", marginTop: 3 }, time: { fontSize: 9, color: palette.muted, fontVariant: ["tabular-nums"] }, speed: { minWidth: 40, minHeight: 44, justifyContent: "center", alignItems: "center", borderRadius: 9, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.white }, speedText: { fontSize: 11, color: palette.accent }, caption: { fontSize: 10, lineHeight: 16, color: palette.muted, marginTop: 10 },
});
