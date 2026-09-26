import Ionicons from "@expo/vector-icons/Ionicons";
import * as Haptics from "expo-haptics";
import { createContext, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { AccessibilityInfo, ActivityIndicator, Animated, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

// The web palette, with slightly darker secondary text for small native labels.
export const palette = { ink: "#272D29", muted: "#657068", accent: "#246653", accentDark: "#1C5142", canvas: "#FFFFFF", surface: "#F7F8F7", line: "#E7EAE7", white: "#FFFFFF", green: "#EDF3EF", red: "#AB4545", redLight: "#FAF0F0" };
export type IconName = ComponentProps<typeof Ionicons>["name"];
export function Icon({ name, size = 20, color = palette.ink }: { name: IconName; size?: number; color?: string }) {
  return <Ionicons name={name} size={size} color={color} accessible={false} />;
}
export function feedback() { void Haptics.selectionAsync().catch(() => undefined); }

const ReducedMotionContext = createContext(false);
export function MotionPreferences({ children }: { children: ReactNode }) {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (mounted) setReduced(value); });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => { mounted = false; subscription.remove(); };
  }, []);
  return <ReducedMotionContext.Provider value={reduced}>{children}</ReducedMotionContext.Provider>;
}
export function useReducedMotion() { return useContext(ReducedMotionContext); }

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
export function Touch({ children, style, onPress, disabled, ...props }: Omit<PressableProps, "style" | "children"> & { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const scale = useRef(new Animated.Value(1)).current;
  const reduced = useReducedMotion();
  useEffect(() => () => scale.stopAnimation(), [scale]);
  const animate = (value: number) => {
    if (reduced) return;
    Animated.spring(scale, { toValue: value, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  };
  return <AnimatedPressable {...props} accessibilityRole={props.accessibilityRole ?? "button"} accessibilityState={{ ...props.accessibilityState, disabled: Boolean(disabled) }} disabled={disabled} onPressIn={() => animate(0.985)} onPressOut={() => animate(1)} onPress={onPress} style={[style, disabled && styles.buttonDisabled, { transform: [{ scale }] }]}>{children}</AnimatedPressable>;
}

export function IconButton({ icon, label, onPress, disabled = false, tone = "default" }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean; tone?: "default" | "accent" | "danger" }) {
  return <Touch accessibilityLabel={label} onPress={onPress} disabled={disabled} style={[styles.iconButton, tone === "accent" && styles.iconButtonAccent]}><Icon name={icon} color={tone === "danger" ? palette.red : tone === "accent" ? palette.accent : palette.ink} /></Touch>;
}

export function ActionButton({ label, onPress, disabled = false, quiet = false, icon, loading = false }: { label: string; onPress: () => void; disabled?: boolean; quiet?: boolean; icon?: IconName; loading?: boolean }) {
  return <Touch onPress={onPress} disabled={disabled || loading} style={[styles.button, quiet && styles.buttonQuiet]}>{loading ? <ActivityIndicator color={quiet ? palette.accent : palette.white} /> : icon ? <Icon name={icon} size={19} color={quiet ? palette.accent : palette.white} /> : null}<Text style={[styles.buttonLabel, quiet && styles.buttonLabelQuiet]}>{label}</Text></Touch>;
}

export function SmallButton({ label, onPress, quiet = false, danger = false }: { label: string; onPress: () => void; quiet?: boolean; danger?: boolean }) {
  return <Touch onPress={onPress} style={[styles.smallButton, quiet && styles.buttonQuiet, danger && styles.buttonDanger]}><Text style={[styles.smallButtonText, quiet && styles.buttonLabelQuiet, danger && styles.buttonLabel]}>{label}</Text></Touch>;
}

export function Card({ children }: { children: ReactNode }) { return <View style={styles.card}>{children}</View>; }
export function SectionTitle({ title, eyebrow }: { title: string; eyebrow?: string }) { return <View style={styles.sectionTitle}>{eyebrow && <Text style={styles.eyebrow}>{eyebrow}</Text>}<Text style={styles.sectionHeading}>{title}</Text></View>; }
export function Pill({ label, selected, disabled = false, onPress }: { label: string; selected: boolean; disabled?: boolean; onPress: () => void }) {
  return <Touch accessibilityState={{ selected }} onPress={onPress} disabled={disabled} style={[styles.pill, selected && styles.pillSelected]}><Text numberOfLines={1} style={[styles.pillText, selected && styles.pillTextSelected]}>{label}</Text></Touch>;
}

export function SearchField({ value, onChangeText, placeholder }: { value: string; onChangeText: (value: string) => void; placeholder: string }) {
  return <View style={styles.search}><Icon name="search-outline" size={18} color={palette.muted} /><TextInput accessibilityLabel={placeholder} style={styles.searchInput} value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={palette.muted} autoCorrect={false} returnKeyType="search" clearButtonMode="while-editing" /></View>;
}

export function Empty({ icon = "call-outline", title, detail, action, onAction, secondary, onSecondary }: { icon?: IconName; title: string; detail: string; action?: string; onAction?: () => void; secondary?: string; onSecondary?: () => void }) {
  return <View style={styles.empty}><View style={styles.emptyIcon}><Icon name={icon} size={28} color={palette.muted} /></View><Text style={styles.emptyTitle}>{title}</Text><Text style={styles.emptyDetail}>{detail}</Text>{action && onAction && <View style={styles.emptyAction}><ActionButton label={action} onPress={onAction} /></View>}{secondary && onSecondary && <Touch onPress={onSecondary} style={styles.textButton}><Text style={styles.textButtonLabel}>{secondary}</Text><Icon name="arrow-forward" size={16} color={palette.accent} /></Touch>}</View>;
}

export function Sheet({ visible, title, onClose, children, closeDisabled = false }: { visible: boolean; title: string; onClose: () => void; children: ReactNode; closeDisabled?: boolean }) {
  const reduced = useReducedMotion();
  return <Modal visible={visible} animationType={reduced ? "none" : "slide"} presentationStyle={Platform.OS === "ios" ? "pageSheet" : "fullScreen"} allowSwipeDismissal={!closeDisabled} onRequestClose={() => { if (!closeDisabled) onClose(); }}>
    <SafeAreaProvider><SafeAreaView style={styles.sheet} edges={Platform.OS === "ios" ? ["bottom", "left", "right"] : ["top", "bottom", "left", "right"]}>
      <View style={styles.sheetHandle} />
      <View style={styles.sheetHeader}><Text accessibilityRole="header" style={styles.sheetTitle}>{title}</Text><IconButton icon="close" label="Fermer" onPress={onClose} disabled={closeDisabled} /></View>
      {children}
    </SafeAreaView></SafeAreaProvider>
  </Modal>;
}

// Native targets stay at least 44 pt; visual weight comes from spacing and fine rules.
export const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: palette.canvas },
  flex: { flex: 1 },
  authScreen: { flex: 1, backgroundColor: palette.canvas },
  authContent: { flexGrow: 1, justifyContent: "center", padding: 28 },
  authCard: { width: "100%", maxWidth: 400, alignSelf: "center", paddingVertical: 24 },
  brandMark: { height: 42, width: 42, borderRadius: 10, backgroundColor: palette.accent, alignItems: "center", justifyContent: "center", marginBottom: 28 },
  brandLetter: { color: palette.white, fontSize: 30, fontWeight: "500" },
  header: { paddingHorizontal: 22, paddingTop: 12, paddingBottom: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  headerTitle: { color: palette.ink, fontSize: 28, lineHeight: 35, fontWeight: "400", letterSpacing: -0.8, marginTop: 5 },
  headerBrand: { color: palette.muted, fontSize: 9, fontWeight: "500", letterSpacing: 1.4 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 2 },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  avatarInitial: { width: 30, height: 30, borderRadius: 15, backgroundColor: "#EEF1EE", alignItems: "center", justifyContent: "center" },
  avatarText: { color: palette.muted, fontWeight: "500", fontSize: 12 },
  selectors: { paddingBottom: 8 },
  pills: { paddingHorizontal: 22, gap: 8, paddingVertical: 4 },
  pill: { borderRadius: 8, backgroundColor: palette.white, borderWidth: 1, borderColor: palette.line, paddingVertical: 10, paddingHorizontal: 12, maxWidth: 250, minHeight: 44, justifyContent: "center" },
  pillSelected: { borderColor: "#BCCFC2", backgroundColor: palette.green },
  pillText: { color: palette.muted, fontSize: 12, fontWeight: "400" },
  pillTextSelected: { color: palette.accent, fontWeight: "500" },
  content: { flexGrow: 1, paddingHorizontal: 22, paddingBottom: 24, gap: 22 },
  listContent: { flexGrow: 1, paddingHorizontal: 22, paddingBottom: 24 },
  listHeader: { gap: 14, paddingBottom: 10 },
  card: { backgroundColor: palette.white, borderRadius: 10, padding: 16, borderWidth: 1, borderColor: palette.line },
  sectionTitle: { marginBottom: 14, gap: 5 },
  sectionHeading: { color: palette.ink, fontSize: 18, fontWeight: "500", letterSpacing: -0.3 },
  eyebrow: { color: palette.muted, fontSize: 10, fontWeight: "500", letterSpacing: 0.8 },
  title: { color: palette.ink, fontSize: 32, fontWeight: "400", letterSpacing: -0.9, marginTop: 10 },
  body: { color: palette.muted, fontSize: 15, lineHeight: 23, marginTop: 10, marginBottom: 28 },
  fieldLabel: { color: palette.ink, fontSize: 12, fontWeight: "500", marginTop: 14, marginBottom: 8 },
  input: { backgroundColor: palette.surface, color: palette.ink, borderWidth: 1, borderColor: palette.line, borderRadius: 8, paddingHorizontal: 13, paddingVertical: 13, fontSize: 16, minHeight: 48, marginBottom: 10 },
  multiline: { minHeight: 100, maxHeight: 180, textAlignVertical: "top" },
  button: { flexDirection: "row", gap: 8, backgroundColor: palette.accent, borderRadius: 8, paddingHorizontal: 17, paddingVertical: 12, alignItems: "center", justifyContent: "center", minHeight: 46, marginTop: 4 },
  buttonQuiet: { backgroundColor: palette.green },
  buttonDisabled: { opacity: 0.42 },
  buttonLabel: { color: palette.white, fontSize: 14, fontWeight: "500", flexShrink: 1, textAlign: "center" },
  buttonLabelQuiet: { color: palette.accent },
  smallButton: { backgroundColor: palette.accent, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 8, minHeight: 44, justifyContent: "center" },
  smallButtonText: { color: palette.white, fontSize: 13, fontWeight: "500" },
  buttonDanger: { backgroundColor: palette.red },
  iconButton: { width: 44, height: 44, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "transparent" },
  iconButtonAccent: { backgroundColor: palette.green },
  hint: { color: palette.muted, fontSize: 13, lineHeight: 20, marginTop: 8 },
  muted: { color: palette.muted, fontSize: 14, marginTop: 12 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: palette.canvas },
  listRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 16, minHeight: 76, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitle: { color: palette.ink, fontWeight: "400", fontSize: 15, letterSpacing: -0.15 },
  rowMeta: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 4 },
  rowTrailing: { alignItems: "flex-end", gap: 8 },
  rowDate: { color: palette.muted, fontSize: 11 },
  unreadDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: palette.accent },
  duplicateWarning: { color: "#805522", backgroundColor: "#FFF8EB", borderRadius: 8, padding: 12, fontSize: 13, lineHeight: 19, marginBottom: 10 },
  roundIcon: { height: 38, width: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: "#EEF1EE" },
  green: { backgroundColor: palette.green },
  gray: { backgroundColor: palette.surface },
  iconText: { color: "#59665D", fontSize: 13, fontWeight: "500" },
  missedIcon: { backgroundColor: palette.redLight },
  missedText: { color: palette.red },
  empty: { alignItems: "center", paddingVertical: 38, paddingHorizontal: 12 },
  emptyIcon: { width: 56, height: 56, borderRadius: 14, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, alignItems: "center", justifyContent: "center", marginBottom: 22 },
  emptyTitle: { color: palette.ink, fontSize: 22, lineHeight: 29, fontWeight: "400", letterSpacing: -0.5, textAlign: "center", maxWidth: 300 },
  emptyDetail: { color: palette.muted, fontSize: 14, lineHeight: 22, textAlign: "center", marginTop: 10, maxWidth: 280 },
  emptyAction: { marginTop: 22, minWidth: 190, maxWidth: "100%" },
  textButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, minHeight: 44, marginTop: 8 },
  textButtonLabel: { color: palette.accent, fontSize: 13, fontWeight: "400" },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  messageBubble: { alignSelf: "flex-start", maxWidth: "86%", backgroundColor: palette.surface, borderRadius: 12, borderBottomLeftRadius: 4, paddingHorizontal: 14, paddingVertical: 11, marginBottom: 10 },
  outgoingBubble: { alignSelf: "flex-end", backgroundColor: palette.green, borderBottomLeftRadius: 12, borderBottomRightRadius: 4 },
  messageText: { color: palette.ink, fontSize: 15, lineHeight: 22 },
  messageMeta: { color: palette.muted, fontSize: 10, marginTop: 7, textAlign: "right" },
  notice: { marginHorizontal: 22, marginBottom: 12, backgroundColor: palette.redLight, borderRadius: 8, padding: 12, flexDirection: "row", gap: 9, alignItems: "center" },
  noticeText: { color: palette.red, fontSize: 13, lineHeight: 19, flex: 1 },
  callBanner: { marginHorizontal: 22, marginBottom: 14, backgroundColor: palette.green, borderWidth: 1, borderColor: "#D7E5DA", borderRadius: 12, padding: 16, gap: 14 },
  callBannerTitle: { color: palette.accentDark, fontWeight: "500", fontSize: 16 },
  callBannerMeta: { color: palette.accent, fontSize: 12, lineHeight: 18, marginTop: 4 },
  keypad: { alignSelf: "center", width: 232, flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8 },
  keypadKey: { width: 70, height: 48, borderRadius: 8, backgroundColor: palette.white, alignItems: "center", justifyContent: "center" },
  keypadDigit: { color: palette.ink, fontSize: 21, fontWeight: "400" },
  search: { flexDirection: "row", alignItems: "center", gap: 9, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: 8, paddingHorizontal: 12, minHeight: 44 },
  searchInput: { flex: 1, fontSize: 14, color: palette.ink, paddingVertical: 12 },
  lineOverview: { paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line, minHeight: 56 },
  lineLabel: { color: palette.muted, fontSize: 11, marginBottom: 4 },
  lineNumber: { color: palette.ink, fontSize: 13, fontWeight: "500" },
  lineIcon: { backgroundColor: palette.surface, borderRadius: 8, width: 34, height: 36, alignItems: "center", justifyContent: "center" },
  segmentBar: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: palette.line },
  segment: { flex: 1, minHeight: 44, justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 6, borderBottomWidth: 1.5, borderBottomColor: "transparent", marginBottom: -1 },
  segmentActive: { borderBottomColor: palette.accent },
  segmentText: { color: palette.muted, fontSize: 13, fontWeight: "400" },
  segmentTextActive: { color: palette.accent, fontWeight: "500" },
  listCaption: { color: palette.muted, fontSize: 10, fontWeight: "400", letterSpacing: 0.7, marginTop: 4 },
  nav: { backgroundColor: palette.white, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line, paddingHorizontal: 8, paddingTop: 4 },
  navRow: { flexDirection: "row", alignItems: "center", minHeight: 58 },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 54, gap: 5 },
  tabIcon: { height: 28, alignItems: "center", justifyContent: "center" },
  tabLabel: { color: palette.muted, fontSize: 10, fontWeight: "400" },
  tabActive: { color: palette.accent, fontWeight: "500" },
  dialerButton: { width: 40, height: 28, borderRadius: 8, backgroundColor: palette.green, justifyContent: "center", alignItems: "center" },
  badge: { position: "absolute", top: 0, right: 14, backgroundColor: palette.accent, borderRadius: 8, minWidth: 16, height: 16, alignItems: "center", justifyContent: "center", paddingHorizontal: 3, borderWidth: 2, borderColor: palette.white },
  badgeText: { color: palette.white, fontSize: 8, fontWeight: "500" },
  sheet: { flex: 1, backgroundColor: palette.canvas },
  sheetHandle: { width: 32, height: 4, borderRadius: 2, backgroundColor: "#D8DDD9", alignSelf: "center", marginTop: 10, marginBottom: 4 },
  sheetHeader: { paddingHorizontal: 22, paddingTop: 8, paddingBottom: 18, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  sheetTitle: { color: palette.ink, fontSize: 21, fontWeight: "400", letterSpacing: -0.5 },
  settingsAccount: { flexDirection: "row", alignItems: "center", paddingVertical: 16, gap: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line },
  settingsAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: "#EEF1EE", alignItems: "center", justifyContent: "center" },
  settingsInitial: { color: palette.muted, fontSize: 19, fontWeight: "400" },
  settingsLabel: { color: palette.muted, fontSize: 10, fontWeight: "500", letterSpacing: 0.8, marginBottom: 12, paddingLeft: 1 },
  permissionRow: { flexDirection: "row", gap: 12, alignItems: "center", paddingVertical: 12 },
  composer: { paddingHorizontal: 22, paddingTop: 14, paddingBottom: 16, backgroundColor: palette.white, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  composerMeta: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
});
