import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { editDialNumber, isDialableNumber } from "./phone";
import { ActionButton, Icon, Sheet, Touch, feedback, palette } from "./ui";

const keys = [["1", ""], ["2", "ABC"], ["3", "DEF"], ["4", "GHI"], ["5", "JKL"], ["6", "MNO"], ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"], ["*", ""], ["0", "+"], ["#", ""]];

// Local state keeps digit presses independent of workspace, messages and history renders.
export function Dialer({ initialNumber, lineNumber, canCall, unavailableReason, busy, notice, onClose, onCall, onContacts }: {
  initialNumber: string; lineNumber?: string; canCall: boolean; unavailableReason: string; busy: boolean; notice: string;
  onClose: (number: string) => void; onCall: (number: string) => Promise<void>; onContacts: (number: string) => void;
}) {
  const [number, setNumber] = useState(initialNumber);
  const [selection, setSelection] = useState({ start: initialNumber.length, end: initialNumber.length });
  const edit = (digit: string | null) => {
    const next = editDialNumber(number, selection, digit);
    setNumber(next.value); setSelection(next.selection); feedback();
  };
  return <Sheet visible title="Clavier" onClose={() => onClose(number)} closeDisabled={busy}>
    <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <View style={s.line}><Icon name="phone-portrait-outline" size={15} color={palette.accent} /><Text style={s.lineText}>{lineNumber ?? "Aucune ligne attribuée"}</Text></View>
      <View style={s.numberArea}>
        <TextInput accessibilityLabel="Numéro à appeler" value={number} onChangeText={(value) => { const next = value.replace(/[^\d+*#\s().-]/g, "").slice(0, 32); setNumber(next); setSelection({ start: next.length, end: next.length }); }} selection={selection} onSelectionChange={(event) => setSelection(event.nativeEvent.selection)} style={[s.number, number.length > 15 && s.longNumber]} placeholder="Saisir un numéro" placeholderTextColor={palette.muted} showSoftInputOnFocus={false} keyboardType="phone-pad" editable={!busy} maxLength={32} caretHidden={false} />
        <Touch style={s.contactLink} onPress={() => onContacts(number)} disabled={busy}><Icon name="people-outline" size={16} color={palette.accent} /><Text style={s.contactLinkText}>Choisir un contact</Text></Touch>
      </View>
      <View style={s.grid}>{keys.map(([digit, letters]) => <Touch key={digit} accessibilityLabel={digit === "0" ? "0, maintenir pour plus" : digit} disabled={busy} style={s.key} delayLongPress={450} onLongPress={digit === "0" ? () => edit("+") : undefined} onPress={() => edit(digit)}><Text style={s.digit}>{digit}</Text><Text style={s.letters}>{letters || " "}</Text></Touch>)}</View>
      <View style={s.actions}><View style={s.side} /><View style={s.call}><ActionButton icon="call" label={busy ? "Connexion…" : "Appeler"} loading={busy} disabled={!canCall || !isDialableNumber(number)} onPress={() => { feedback(); void onCall(number); }} /></View><View style={s.side}><Touch accessibilityLabel="Effacer un chiffre, maintenir pour tout effacer" style={s.erase} disabled={!number || busy} onPress={() => edit(null)} onLongPress={() => { setNumber(""); setSelection({ start: 0, end: 0 }); feedback(); }}><Icon name="backspace-outline" size={26} color={palette.muted} /></Touch></View></View>
      <Text style={s.hint}>{!canCall ? unavailableReason : number && !isDialableNumber(number) ? "Saisissez un numéro valide, avec son indicatif international." : "Maintenez le 0 pour saisir +."}</Text>
      {!!notice && <Text accessibilityRole="alert" style={s.error}>{notice}</Text>}
    </ScrollView>
  </Sheet>;
}

const s = StyleSheet.create({
  content: { flexGrow: 1, alignItems: "center", paddingHorizontal: 24, paddingBottom: 22, maxWidth: 430, width: "100%", alignSelf: "center" },
  line: { flexDirection: "row", gap: 7, alignItems: "center", justifyContent: "center", paddingVertical: 8, paddingHorizontal: 12 },
  lineText: { fontSize: 12, fontWeight: "400", color: palette.muted },
  numberArea: { width: "100%", minHeight: 142, justifyContent: "center", paddingTop: 20, paddingBottom: 14 },
  number: { fontSize: 30, fontWeight: "300", color: palette.ink, textAlign: "center", minHeight: 48, letterSpacing: 0.2, paddingVertical: 5 },
  longNumber: { fontSize: 22 },
  contactLink: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, minHeight: 44 },
  contactLinkText: { fontSize: 13, fontWeight: "400", color: palette.accent },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", width: "100%", maxWidth: 304, gap: 12 },
  key: { width: "29%", aspectRatio: 1.18, borderRadius: 12, backgroundColor: palette.surface, alignItems: "center", justifyContent: "center" },
  digit: { fontSize: 30, lineHeight: 38, color: palette.ink, fontWeight: "300" },
  letters: { fontSize: 9, letterSpacing: 1.5, color: palette.muted, fontWeight: "400", minHeight: 14 },
  actions: { flexDirection: "row", alignItems: "center", justifyContent: "center", width: "100%", marginTop: 28, gap: 5 },
  call: { flex: 1, maxWidth: 210 },
  side: { width: 48, alignItems: "center" },
  erase: { width: 48, height: 50, justifyContent: "center", alignItems: "center" },
  hint: { color: palette.muted, textAlign: "center", fontSize: 12, lineHeight: 19, marginTop: 17, maxWidth: 310 },
  error: { color: palette.red, textAlign: "center", fontSize: 13, lineHeight: 19, marginTop: 12 },
});
