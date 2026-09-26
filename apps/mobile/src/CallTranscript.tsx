import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, FlatList, Share, StyleSheet, Text, View } from "react-native";
import { transcriptPath, transcriptRows, transcriptStatus, transcriptText, transcriptTime, watchTranscript, type TranscriptApi, type TranscriptTarget, type TranscriptionResponse } from "@onoff/api-client";
import { ActionButton, Icon, Sheet, Touch, palette } from "./ui";

export function CallTranscript({ api, target, remoteName = "Interlocuteur", onClose, onHangup }: {
  api: TranscriptApi; target: TranscriptTarget; remoteName?: string; onClose(): void; onHangup?: (() => void) | undefined;
}) {
  const [data, setData] = useState<TranscriptionResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [following, setFollowing] = useState(true);
  const [revision, setRevision] = useState(0);
  const list = useRef<FlatList>(null);
  const path = transcriptPath(target);
  useEffect(() => {
    setData(null); setError(""); setFollowing(true);
    let cancel: (() => void) | undefined;
    const resume = () => {
      cancel?.();
      cancel = watchTranscript(api, target, { onData: (next) => { setData(next); setError(""); }, onError: (message, lost) => { setError(message); if (lost) setData(null); } });
    };
    resume();
    const state = AppState.addEventListener("change", (value) => { if (value === "active") resume(); else cancel?.(); });
    return () => { cancel?.(); state.remove(); };
  }, [api, path, revision]);
  const transcript = data?.transcript;
  const rows = transcript ? transcriptRows(transcript) : [];
  const live = transcript?.status === "live";
  async function act(stop = false) {
    setBusy(true); setError("");
    try { setData(await api<TranscriptionResponse>(stop ? `/v1/calls/${data!.callId}/transcription/stop` : path, { method: "POST" })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "La demande a échoué."); }
    finally { setBusy(false); }
  }
  async function share() {
    try { await Share.share({ title: "Transcription de l’appel", message: transcriptText(transcript!, remoteName) }); }
    catch { setError("Le partage est momentanément indisponible."); }
  }
  return <Sheet visible title="Le fil de votre appel" onClose={onClose}>
    <View style={s.header}><View style={s.mark}><Icon name="document-text-outline" color={palette.accent} size={21} /></View><View style={s.headerCopy}><Text style={s.title}>{remoteName}</Text><Text style={s.subtitle}>Chaque mot, à portée de regard.</Text></View><View style={[s.badge, live && s.liveBadge]}>{live && <View style={s.dot} />}<Text accessibilityLiveRegion="polite" style={[s.badgeText, live && { color: palette.accent }]}>{transcript ? transcriptStatus[transcript.status] : "Transcription"}</Text></View></View>
    {!!error && <View style={s.error}><Text accessibilityRole="alert" style={s.errorText}>{error}</Text><Touch onPress={() => setRevision((value) => value + 1)} style={s.retry}><Text style={s.retryText}>Actualiser</Text></Touch></View>}
    {!!transcript?.error && <Text style={[s.error, s.errorText]}>{transcript.error}</Text>}
    <View style={s.body}>
      <FlatList ref={list} data={rows} keyExtractor={(row) => row.id} contentContainerStyle={rows.length ? s.lines : s.emptyContainer} showsVerticalScrollIndicator={false} initialNumToRender={25}
        onContentSizeChange={() => { if (following) list.current?.scrollToEnd({ animated: false }); }}
        onScroll={(event) => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; setFollowing(contentSize.height - contentOffset.y - layoutMeasurement.height < 90); }} scrollEventThrottle={100}
        ListEmptyComponent={<View style={s.empty}><View style={s.orbit}>{!data || transcript?.status === "starting" ? <ActivityIndicator color={palette.accent} /> : <Icon name="pulse-outline" size={36} color={palette.accent} />}</View><Text style={s.eyebrow}>VOTRE CONVERSATION, EN CLAIR</Text><Text style={s.emptyTitle}>{!data ? "Préparation de la transcription…" : live ? "À l’écoute de\nvotre échange." : transcript ? transcript.status === "completed" ? "Aucune parole transcrite." : transcriptStatus[transcript.status] : data.available && data.callActive && target.providerCallSid ? "Concentrez-vous sur\nla conversation." : "Aucune transcription\ndisponible."}</Text><Text style={s.description}>{!data ? "Nous retrouvons votre appel." : transcript ? "Les phrases apparaissent ici au fil de l’appel." : data.available && data.callActive && target.providerCallSid ? "Les deux voix s’affichent en direct et restent disponibles après l’appel. Informez votre interlocuteur avant de commencer." : !data.available ? "La transcription doit être activée par votre administrateur." : "La transcription n’a pas été démarrée pendant cet appel."}</Text>{data?.available && data.callActive && !transcript && target.providerCallSid && <ActionButton icon="pulse-outline" label="Démarrer la transcription" loading={busy} onPress={() => void act()} />}</View>}
        renderItem={({ item: row }) => <View style={s.line}><View style={[s.avatar, row.speaker === "local" && s.localAvatar]}><Text style={[s.initial, row.speaker === "local" && { color: palette.accent }]}>{row.speaker === "local" ? "V" : remoteName.slice(0, 1).toUpperCase()}</Text></View><View style={s.copy}><View style={s.meta}><Text style={[s.speaker, row.speaker === "local" && { color: palette.accent }]} numberOfLines={1}>{row.speaker === "local" ? "Vous" : remoteName}</Text><Text style={s.time}>{transcriptTime(row.offsetMs)}</Text>{row.partial && <Text style={s.partialLabel}>En cours</Text>}</View><Text selectable style={[s.text, row.partial && { color: palette.muted }]}>{row.text}{row.partial ? " ▏" : ""}</Text></View></View>} />
      {!following && rows.length > 0 && <Touch style={s.follow} onPress={() => { setFollowing(true); list.current?.scrollToEnd({ animated: false }); }}><Icon name="arrow-down" size={14} color={palette.accent} /><Text style={s.followText}>Revenir au direct</Text></Touch>}
    </View>
    <View style={s.footer}><Text style={s.credit}>Ⅱ  Scribe v2 · {transcript?.segments.length ?? 0} passages</Text><View style={s.actions}>{(live || transcript?.status === "starting") && <Touch style={s.footerButton} disabled={busy} accessibilityLabel="Arrêter la transcription" onPress={() => void act(true)}><Icon name="stop-circle-outline" size={22} color={palette.muted} /></Touch>}<Touch style={s.footerButton} disabled={!transcript?.segments.length} accessibilityLabel="Partager la transcription" onPress={() => void share()}><Icon name="share-outline" size={22} color={transcript?.segments.length ? palette.accent : "#a9b0ab"} /></Touch></View></View>
    {onHangup && <View style={s.callControls}><View style={s.callIndicator}><View style={s.dot} /><Text style={s.callText}>Votre appel continue</Text></View><Touch style={s.hangup} accessibilityLabel="Raccrocher l’appel" onPress={onHangup}><Icon name="call" size={19} color={palette.white} /><Text style={s.hangupText}>Raccrocher</Text></Touch></View>}
  </Sheet>;
}

const s = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 22, paddingBottom: 22, borderBottomWidth: 1, borderColor: palette.line },
  mark: { width: 38, height: 38, alignItems: "center", justifyContent: "center", backgroundColor: palette.green, borderRadius: 10 },
  headerCopy: { flex: 1 }, title: { fontSize: 13, fontWeight: "500", color: palette.ink }, subtitle: { fontSize: 10, color: palette.muted, marginTop: 5 },
  badge: { flexDirection: "row", alignItems: "center", gap: 6, maxWidth: 125 }, liveBadge: { backgroundColor: palette.green, borderRadius: 20, paddingHorizontal: 9, paddingVertical: 6 }, badgeText: { fontSize: 10, color: palette.muted, flexShrink: 1 }, dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: palette.accent },
  body: { flex: 1 }, lines: { paddingHorizontal: 22, paddingTop: 28, paddingBottom: 48, gap: 28 },
  line: { flexDirection: "row", gap: 12 }, avatar: { width: 28, height: 28, borderRadius: 9, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, justifyContent: "center", alignItems: "center" }, localAvatar: { backgroundColor: palette.green, borderColor: "#DCE5DF" }, initial: { fontSize: 10, color: palette.muted, fontWeight: "500" }, copy: { flex: 1 },
  meta: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 5, marginBottom: 10 }, speaker: { fontSize: 11, fontWeight: "600", color: palette.ink, maxWidth: "55%" }, time: { fontSize: 10, color: palette.muted, fontVariant: ["tabular-nums"] }, partialLabel: { marginLeft: "auto", fontSize: 9, color: palette.muted }, text: { fontSize: 16, lineHeight: 27, letterSpacing: -.2, color: palette.ink },
  emptyContainer: { flexGrow: 1, justifyContent: "center" }, empty: { alignItems: "center", paddingHorizontal: 32, paddingVertical: 44 }, orbit: { width: 82, height: 82, borderRadius: 41, borderWidth: 8, borderColor: "#F8FAF8", backgroundColor: palette.green, alignItems: "center", justifyContent: "center", marginBottom: 30 }, eyebrow: { fontSize: 9, letterSpacing: 1.4, color: palette.muted, marginBottom: 14 }, emptyTitle: { fontSize: 25, lineHeight: 33, letterSpacing: -.8, color: palette.ink, textAlign: "center", fontWeight: "400" }, description: { fontSize: 13, lineHeight: 22, color: palette.muted, textAlign: "center", marginTop: 16, marginBottom: 25, maxWidth: 320 },
  follow: { position: "absolute", bottom: 15, alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 7, minHeight: 44, paddingHorizontal: 17, borderRadius: 24, backgroundColor: palette.white, borderWidth: 1, borderColor: "#D4DFD7", shadowColor: palette.accent, shadowOpacity: .07, shadowRadius: 10, elevation: 2 }, followText: { fontSize: 12, color: palette.accent },
  footer: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 22, paddingVertical: 8, borderTopWidth: 1, borderColor: palette.line, backgroundColor: "#FAFBFA" }, credit: { fontSize: 10, color: palette.muted }, actions: { flexDirection: "row", gap: 6 }, footerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  error: { padding: 15, backgroundColor: palette.redLight }, errorText: { color: palette.red, fontSize: 12, lineHeight: 19 }, retry: { minHeight: 44, justifyContent: "center" }, retryText: { color: palette.accent, fontSize: 12, fontWeight: "500" },
  callControls: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 14, paddingHorizontal: 22, borderTopWidth: 1, borderColor: palette.line }, callIndicator: { flexDirection: "row", gap: 7, alignItems: "center" }, callText: { fontSize: 11, color: palette.muted }, hangup: { minHeight: 44, paddingHorizontal: 15, borderRadius: 24, flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: palette.red }, hangupText: { color: palette.white, fontSize: 12, fontWeight: "500" },
});
