import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { themedStyles } from "./theme";
import { Icon, Touch, feedback, palette } from "./ui";

type CallStatus = "connecting" | "ringing" | "active" | "reconnecting";

export function CallScreen({
  status, incoming, name, number, connectedAt, muted, keypadVisible, audioLabel, notice,
  canTranscribe, bottomInset, onMute, onKeypad, onAudio, onDigit, onTranscribe, onAccept, onDecline, onHangup, onDismissNotice,
}: {
  status: CallStatus;
  incoming: boolean;
  name: string;
  number: string;
  connectedAt: number | null;
  muted: boolean;
  keypadVisible: boolean;
  audioLabel: string;
  notice: string;
  canTranscribe: boolean;
  bottomInset: number;
  onMute(): void;
  onKeypad(): void;
  onAudio(): void;
  onDigit(digit: string): void;
  onTranscribe(): void;
  onAccept(): void;
  onDecline(): void;
  onHangup(): void;
  onDismissNotice(): void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (status !== "active" || !connectedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connectedAt, status]);

  const elapsedSeconds = connectedAt ? Math.max(0, Math.floor((now - connectedAt) / 1000)) : 0;
  const elapsed = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, "0")}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
  const title = name || number || "Interlocuteur";
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toLocaleUpperCase();
  const connected = status === "active";
  const statusText = incoming && status === "ringing"
    ? "Appel entrant"
    : status === "connecting" ? "Connexion en cours…"
      : status === "ringing" ? "Ça sonne…"
        : status === "reconnecting" ? "Rétablissement de la connexion…"
          : "Appel en cours";

  return <View style={s.screen}>
    <View style={s.topBar}>
      <View style={s.brandMark}><Icon name="call" size={18} color={palette.accent} /></View>
      <View style={s.brandCopy}><Text style={s.brand}>ONOFF BUSINESS</Text><Text style={s.caption}>Votre ligne professionnelle</Text></View>
      <View style={[s.statePill, status === "reconnecting" && s.stateWarning]}>
        {status === "connecting" || status === "reconnecting" ? <ActivityIndicator size="small" color={status === "reconnecting" ? palette.amber : palette.accent} /> : <View style={[s.stateDot, !connected && s.stateDotQuiet]} />}
        <Text style={[s.stateText, status === "reconnecting" && s.stateTextWarning]}>{status === "active" ? "EN LIGNE" : incoming && status === "ringing" ? "ENTRANT" : status === "ringing" ? "SONNERIE" : status === "reconnecting" ? "RECONNEXION" : "APPEL"}</Text>
      </View>
    </View>

    <ScrollView style={s.scroll} contentContainerStyle={[s.content, { paddingBottom: Math.max(bottomInset, 18) + 20 }]} showsVerticalScrollIndicator={false}>
      <View style={s.person}>
        <View style={s.avatarHalo}>
          <View style={s.avatar}>
            {initials ? <Text style={s.initials}>{initials}</Text> : <Icon name="person-outline" size={46} color={palette.accent} />}
          </View>
          {connected && <View style={s.avatarStatus}><Icon name="call" size={14} color={palette.white} /></View>}
        </View>
        <Text accessibilityRole="header" numberOfLines={2} style={s.name}>{title}</Text>
        {!!name && !!number && <Text style={s.number}>{number}</Text>}
        <View style={s.callState}>
          <Text accessibilityLiveRegion="polite" style={s.statusText}>{connected ? elapsed : statusText}</Text>
          {connected && <Text style={s.timerHint}>Durée de l’appel</Text>}
        </View>
      </View>

      {keypadVisible && !incoming && <View style={s.keypad}>
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((digit) => <Touch key={digit} accessibilityLabel={`Tonalité ${digit}`} style={s.key} onPress={() => { feedback(); onDigit(digit); }}><Text style={s.digit}>{digit}</Text></Touch>)}
      </View>}

      {incoming ? <View style={s.incomingActions}>
        <CallAction icon="close" label="Refuser" tone="danger" onPress={onDecline} />
        <CallAction icon="call" label="Répondre" tone="success" onPress={onAccept} />
      </View> : <>
        <View style={s.controls}>
          <CallAction icon={muted ? "mic-off-outline" : "mic-outline"} label={muted ? "Micro coupé" : "Micro"} active={muted} onPress={onMute} />
          <CallAction icon="keypad-outline" label="Clavier" active={keypadVisible} onPress={onKeypad} />
          <CallAction icon="volume-high-outline" label="Audio" onPress={onAudio} />
        </View>
        <Touch accessibilityLabel="Raccrocher l’appel" onPress={onHangup} style={s.hangup}>
          <Icon name="call" size={23} color={palette.white} />
          <Text style={s.hangupText}>Raccrocher</Text>
        </Touch>
      </>}

      {canTranscribe && connected && !keypadVisible && <Touch accessibilityLabel="Voir la transcription en direct" style={s.transcript} onPress={onTranscribe}>
        <View style={s.transcriptIcon}><Icon name="document-text-outline" size={18} color={palette.accent} /></View>
        <Text style={s.transcriptLabel}>Transcription en direct</Text>
        <Icon name="chevron-forward" size={17} color={palette.muted} />
      </Touch>}

      {!incoming && <View style={s.audioInfo}>
        <Icon name="volume-high-outline" size={15} color={palette.muted} />
        <Text numberOfLines={1} style={s.audioText}>Audio · {audioLabel || "Appareil"}</Text>
      </View>}
      {!!notice && <Touch accessibilityRole="button" accessibilityLabel={`${notice}. Fermer le message`} onPress={onDismissNotice} style={s.notice}>
        <Icon name="information-circle-outline" size={19} color={palette.red} />
        <Text accessibilityLiveRegion="polite" style={s.noticeText}>{notice}</Text>
        <Icon name="close" size={16} color={palette.red} />
      </Touch>}
    </ScrollView>
  </View>;
}

function CallAction({ icon, label, onPress, active = false, tone = "default" }: {
  icon: "mic-outline" | "mic-off-outline" | "keypad-outline" | "volume-high-outline" | "close" | "call";
  label: string;
  onPress(): void;
  active?: boolean;
  tone?: "default" | "danger" | "success";
}) {
  const destructive = tone === "danger";
  const positive = tone === "success";
  return <Touch accessibilityLabel={label} onPress={onPress} style={s.action}>
    <View style={[s.actionIcon, active && s.actionIconActive, destructive && s.actionIconDanger, positive && s.actionIconSuccess]}>
      <Icon name={icon} size={23} color={destructive || positive ? palette.white : active ? palette.accent : palette.ink} />
    </View>
    <Text numberOfLines={1} style={[s.actionLabel, (destructive || positive) && s.actionLabelStrong]}>{label}</Text>
  </Touch>;
}

const s = themedStyles({
  screen: { flex: 1 },
  topBar: { minHeight: 66, flexDirection: "row", alignItems: "center", paddingHorizontal: 22, gap: 11, borderBottomWidth: 1, borderBottomColor: palette.line },
  brandMark: { width: 38, height: 38, borderRadius: 12, backgroundColor: palette.lime, alignItems: "center", justifyContent: "center" },
  brandCopy: { flex: 1 },
  brand: { color: palette.ink, fontSize: 10, fontWeight: "600", letterSpacing: 1.1 },
  caption: { color: palette.muted, fontSize: 11, marginTop: 4 },
  statePill: { minHeight: 32, paddingHorizontal: 10, borderRadius: 16, backgroundColor: palette.green, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  stateWarning: { backgroundColor: palette.amberLight },
  stateDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: palette.success },
  stateDotQuiet: { backgroundColor: palette.accent },
  stateText: { color: palette.accent, fontSize: 9, fontWeight: "600", letterSpacing: 0.5 },
  stateTextWarning: { color: palette.amber },
  scroll: { flex: 1 },
  content: { flexGrow: 1, alignItems: "center", paddingHorizontal: 22, paddingTop: 26, gap: 24 },
  person: { alignItems: "center", width: "100%", paddingTop: 8 },
  avatarHalo: { width: 142, height: 142, borderRadius: 71, alignItems: "center", justifyContent: "center", backgroundColor: palette.green, marginBottom: 21 },
  avatar: { width: 116, height: 116, borderRadius: 58, alignItems: "center", justifyContent: "center", backgroundColor: palette.white, borderWidth: 1, borderColor: palette.line },
  initials: { color: palette.accent, fontSize: 36, fontWeight: "600", letterSpacing: -1.4 },
  avatarStatus: { position: "absolute", right: 9, bottom: 10, width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: palette.success, borderWidth: 3, borderColor: palette.canvas },
  name: { color: palette.ink, fontSize: 27, lineHeight: 34, fontWeight: "600", letterSpacing: -0.8, textAlign: "center", maxWidth: "100%" },
  number: { color: palette.muted, fontSize: 14, letterSpacing: 0.2, marginTop: 6 },
  callState: { alignItems: "center", marginTop: 14 },
  statusText: { color: palette.accent, fontSize: 17, fontWeight: "500", fontVariant: ["tabular-nums"] },
  timerHint: { color: palette.muted, fontSize: 11, marginTop: 4 },
  controls: { flexDirection: "row", width: "100%", maxWidth: 360, justifyContent: "center", gap: 12 },
  action: { flex: 1, minWidth: 0, minHeight: 86, alignItems: "center", justifyContent: "center", gap: 8 },
  actionIcon: { width: 58, height: 58, borderRadius: 20, backgroundColor: palette.white, borderWidth: 1, borderColor: palette.line, alignItems: "center", justifyContent: "center" },
  actionIconActive: { backgroundColor: palette.green, borderColor: palette.green },
  actionIconDanger: { backgroundColor: palette.red, borderColor: palette.red },
  actionIconSuccess: { backgroundColor: palette.success, borderColor: palette.success },
  actionLabel: { color: palette.muted, fontSize: 11, fontWeight: "500", textAlign: "center", maxWidth: "100%" },
  actionLabelStrong: { color: palette.ink },
  hangup: { minHeight: 58, minWidth: 180, paddingHorizontal: 25, borderRadius: 29, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: palette.red },
  hangupText: { color: palette.white, fontSize: 15, fontWeight: "600" },
  incomingActions: { flexDirection: "row", justifyContent: "center", width: "100%", maxWidth: 290, gap: 36 },
  keypad: { width: "100%", maxWidth: 300, flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 9 },
  key: { width: "30%", maxWidth: 86, height: 48, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: palette.white, borderWidth: 1, borderColor: palette.line },
  digit: { color: palette.ink, fontSize: 22, fontWeight: "500" },
  transcript: { width: "100%", minHeight: 54, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 13, borderRadius: 14, backgroundColor: palette.white, borderWidth: 1, borderColor: palette.line },
  transcriptIcon: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: palette.green },
  transcriptLabel: { flex: 1, color: palette.ink, fontSize: 13, fontWeight: "500" },
  audioInfo: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 },
  audioText: { color: palette.muted, fontSize: 11, maxWidth: 260 },
  notice: { width: "100%", minHeight: 48, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: palette.redLight, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9 },
  noticeText: { color: palette.red, fontSize: 12, lineHeight: 17, flex: 1 },
});
