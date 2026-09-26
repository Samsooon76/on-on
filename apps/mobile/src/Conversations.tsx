import { buildTimeline, callLabel, formatDuration, initials, isMissedCall, type CallRecord, type InboxConversation, type MessageRecord } from "@onoff/api-client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View } from "react-native";
import { conversationDay, filterInbox, type InboxFilter } from "./conversation-model";
import { callStatusLabel, isDialableNumber, messageStatusLabel, relativeCallDate } from "./phone";
import { ActionButton, Empty, Icon, IconButton, SearchField, Touch, feedback, palette, styles } from "./ui";

export function ConversationInbox(props: {
  inbox: InboxConversation[]; loading: boolean; refreshing: boolean; locked: boolean; header: ReactNode;
  hasMore: boolean; loadingMore: boolean;
  onRefresh(): void; onMore(): void; onOpen(thread: InboxConversation): void; onNew(): void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const visible = useMemo(() => filterInbox(props.inbox, search, filter), [props.inbox, search, filter]);
  const unread = props.inbox.filter((thread) => thread.unread).length;
  const filtered = Boolean(search.trim()) || filter !== "all";
  return <FlatList
    data={visible} keyExtractor={(item) => item.key} contentContainerStyle={styles.listContent}
    keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}
    refreshing={props.refreshing} onRefresh={props.onRefresh} initialNumToRender={12} windowSize={7}
    ListHeaderComponent={<View style={styles.listHeader}>
      {props.header}
      <SearchField placeholder="Rechercher une conversation" value={search} onChangeText={setSearch} />
      <View style={styles.segmentBar}>{([['all', 'Toutes'], ['unread', 'Non lues'], ['missed', 'Manqués']] as const).map(([value, label]) => <Touch key={value} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: filter === value }} style={[styles.segment, filter === value && styles.segmentActive]} onPress={() => { feedback(); setFilter(value); }}><Text style={[styles.segmentText, filter === value && styles.segmentTextActive]}>{label}</Text>{value === "unread" && unread > 0 && <View style={s.filterBadge}><Text style={s.filterCount}>{unread}</Text></View>}</Touch>)}</View>
      <Text style={styles.listCaption}>SMS ET APPELS · {props.inbox.length}{props.hasMore ? "+" : ""} CONVERSATION{props.inbox.length === 1 ? "" : "S"}</Text>
    </View>}
    ListEmptyComponent={props.loading ? <View style={s.loading}><ActivityIndicator color={palette.accent} /><Text style={styles.rowMeta}>Chargement des conversations…</Text></View> : <Empty icon={filter === "missed" ? "call-outline" : "chatbubbles-outline"} title={filtered ? "Aucune conversation trouvée." : "Tous vos échanges,\nau même endroit."} detail={filtered ? "Essayez une autre recherche ou un autre filtre." : "Les SMS et les appels d’un interlocuteur se retrouvent dans une seule conversation."} action={filtered ? "Voir toutes les conversations" : props.locked ? undefined : "Nouvelle conversation"} onAction={() => { if (filtered) { setSearch(""); setFilter("all"); } else props.onNew(); }} />}
    ListFooterComponent={props.hasMore ? <ActionButton quiet icon="time-outline" label="Voir les échanges précédents" loading={props.loadingMore} disabled={props.refreshing} onPress={props.onMore} /> : null}
    renderItem={({ item }) => <Touch style={styles.listRow} disabled={props.locked} accessibilityLabel={`${item.name ?? item.remoteNumber}${item.unread ? ", non lue" : ""}. ${item.preview}`} onPress={() => props.onOpen(item)}>
      <View style={styles.roundIcon}><Text style={styles.iconText}>{initials(item.name ?? item.remoteNumber)}</Text></View>
      <View style={styles.rowCopy}>
        <Text style={[styles.rowTitle, item.unread && s.unreadTitle]} numberOfLines={1}>{item.name ?? item.remoteNumber}</Text>
        <View style={s.preview}><Icon name={item.lastKind === "call" ? "call-outline" : "chatbubble-outline"} size={13} color={item.lastKind === "call" && item.preview === "Appel manqué" ? palette.red : palette.muted} /><Text style={[s.previewText, item.lastKind === "call" && item.preview === "Appel manqué" && styles.missedText]} numberOfLines={1}>{item.preview}</Text></View>
      </View>
      <View style={styles.rowTrailing}><Text style={[styles.rowDate, item.unread && { color: palette.accent }]}>{item.updatedAt ? relativeCallDate(item.updatedAt) : ""}</Text>{item.unread ? <View style={styles.unreadDot} /> : <Icon name="chevron-forward" size={14} color={palette.muted} />}</View>
    </Touch>}
  />;
}

export function ConversationThread(props: {
  number: string; name: string | null; lineNumber: string; calls: CallRecord[]; messages: MessageRecord[];
  state: "loading" | "ready" | "error"; hasOlder: boolean; loadingOlder: boolean; hasMoreCalls: boolean; loadingMore: boolean;
  refreshing: boolean; body: string; recipientEditable: boolean; locked: boolean; pending: boolean; recoveryReady: boolean;
  busy: boolean; canSms: boolean; canCall: boolean; segments: number; bottomInset: number;
  onOlder(): void; onMoreCalls(): void; onRetry(): void; onRefresh(): void; onBody(body: string): void;
  onDestination(number: string): void; onSend(): void; onCall(): void; onTranscript(callId: string): void;
}) {
  const [filter, setFilter] = useState<"all" | "message" | "call">("all");
  const timeline = useMemo(() => buildTimeline(props.messages, props.calls).filter((event) => filter === "all" || event.kind === filter).reverse(), [props.messages, props.calls, filter]);
  const list = useRef<FlatList>(null);
  const nearLatest = useRef(true);
  const newestId = timeline[0]?.id;
  useEffect(() => {
    if (nearLatest.current) list.current?.scrollToOffset({ offset: 0, animated: false });
  }, [newestId, filter]);
  const time = (value: string) => new Date(value).toLocaleTimeString("fr-BE", { hour: "2-digit", minute: "2-digit" });
  const olderControls = <View style={s.olderControls}>
    {props.hasOlder && filter !== "call" && <ActionButton quiet label="Messages précédents" icon="time-outline" loading={props.loadingOlder} onPress={props.onOlder} />}
    {props.hasMoreCalls && filter !== "message" && <ActionButton quiet label="Appels précédents" icon="call-outline" loading={props.loadingMore} disabled={props.refreshing} onPress={props.onMoreCalls} />}
  </View>;
  return <View style={styles.flex}>
    <View style={s.threadTop}>
      {props.recipientEditable && <TextInput accessibilityLabel="Numéro du destinataire" style={[styles.input, s.recipient]} editable={!props.locked && !props.busy} placeholder="À : numéro international" placeholderTextColor={palette.muted} keyboardType="phone-pad" value={props.number} onChangeText={props.onDestination} />}
      {props.name && <Text style={s.threadNumber}>{props.number}</Text>}
      <View style={styles.segmentBar}>{([['all', 'Tout'], ['message', 'SMS'], ['call', 'Appels']] as const).map(([value, label]) => <Touch key={value} accessibilityRole="tab" accessibilityState={{ selected: filter === value }} style={[styles.segment, filter === value && styles.segmentActive]} onPress={() => { feedback(); nearLatest.current = true; setFilter(value); }}><Text style={[styles.segmentText, filter === value && styles.segmentTextActive]}>{label}</Text></Touch>)}</View>
      <Text style={s.lineLabel}>{props.lineNumber ? `Via votre ligne ${props.lineNumber}` : "Aucune ligne attribuée"}</Text>
    </View>
    {props.state === "loading" && <View style={s.status}><ActivityIndicator size="small" color={palette.accent} /><Text style={styles.rowMeta}>Chargement des messages…</Text></View>}
    {props.state === "error" && <View style={s.error}><Text accessibilityRole="alert" style={styles.hint}>Les messages n’ont pas pu être actualisés.</Text><ActionButton quiet label="Réessayer" icon="refresh" onPress={props.onRetry} /></View>}
    {timeline.length ? <FlatList
      ref={list} data={timeline} inverted keyExtractor={(event) => event.id} style={styles.flex} contentContainerStyle={s.timeline}
      keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" initialNumToRender={20}
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      onScroll={(event) => { nearLatest.current = event.nativeEvent.contentOffset.y < 100; }} scrollEventThrottle={100}
      refreshing={props.refreshing} onRefresh={props.onRefresh} ListFooterComponent={olderControls}
      renderItem={({ item: event, index }) => {
        const older = timeline[index + 1];
        const showDay = !older || new Date(older.createdAt).toDateString() !== new Date(event.createdAt).toDateString();
        return <View>
          {showDay && <View style={s.day}><View style={s.dayRule} /><Text style={s.dayText}>{conversationDay(event.createdAt)}</Text><View style={s.dayRule} /></View>}
          {event.kind === "message" ? <View style={[styles.messageBubble, s.bubble, event.message.direction === "outbound" && styles.outgoingBubble, ["failed", "undelivered"].includes(event.message.status) && s.failedBubble]}>
            <Text selectable style={styles.messageText}>{event.message.body}</Text>
            <Text style={styles.messageMeta}>{time(event.createdAt)}{event.message.direction === "outbound" ? ` · ${messageStatusLabel(event.message.status)}` : ""}</Text>
          </View> : <View style={[s.callEvent, isMissedCall(event.call) && s.missedCall]}>
            <View style={[s.callIcon, isMissedCall(event.call) && styles.missedIcon]}><Icon name={isMissedCall(event.call) ? "call-outline" : event.call.direction === "inbound" ? "arrow-down-outline" : "arrow-up-outline"} size={18} color={isMissedCall(event.call) ? palette.red : palette.accent} /></View>
            <View style={styles.rowCopy}><Text style={[s.callTitle, isMissedCall(event.call) && styles.missedText]}>{callLabel(event.call)}</Text><Text style={styles.rowMeta}>{event.call.duration_seconds ? formatDuration(event.call.duration_seconds) : callStatusLabel(event.call.status)} · {time(event.createdAt)}</Text></View>
            <IconButton icon="document-text-outline" label="Voir la transcription de cet appel" onPress={() => props.onTranscript(event.call.id)} />
            <IconButton icon="call-outline" label={`Rappeler ${props.name ?? props.number}`} disabled={!props.canCall || props.busy || !isDialableNumber(props.number)} onPress={props.onCall} />
          </View>}
        </View>;
      }}
    /> : <FlatList data={[]} renderItem={() => null} style={styles.flex} contentContainerStyle={s.emptyTimeline} refreshing={props.refreshing} onRefresh={props.onRefresh} ListHeaderComponent={olderControls} ListEmptyComponent={props.state === "ready" ? <View style={s.threadEmpty}><Icon name={filter === "call" ? "call-outline" : "chatbubbles-outline"} size={28} color={palette.muted} /><Text style={s.emptyTitle}>{filter === "call" ? "Aucun appel dans ce fil" : filter === "message" ? "Pas encore de SMS" : "Le début de votre conversation"}</Text><Text style={s.emptyDetail}>{filter === "call" ? "Vos appels avec cet interlocuteur apparaîtront ici." : "Écrivez un message pour commencer l’échange."}</Text></View> : null} />}
    <View style={[s.composer, { paddingBottom: Math.max(props.bottomInset, 12) }]}>
      {props.pending && <Text style={s.pending}>Cet envoi attend une confirmation. Votre message est conservé.</Text>}
      {!props.canSms && <Text style={styles.hint}>Les SMS ne sont pas activés sur cette ligne.</Text>}
      <View style={s.composeRow}><TextInput accessibilityLabel="Votre message" style={s.messageInput} editable={!props.locked && props.canSms && !props.busy} placeholder="Écrire un SMS…" placeholderTextColor={palette.muted} value={props.body} onChangeText={props.onBody} multiline maxLength={1600} /><Touch accessibilityLabel={props.pending ? "Vérifier l’envoi" : "Envoyer le message"} style={s.send} disabled={props.busy || !props.recoveryReady || !props.canSms || !props.body.trim() || !isDialableNumber(props.number)} onPress={props.onSend}>{props.busy ? <ActivityIndicator color={palette.white} /> : <Icon name={props.pending ? "refresh" : "arrow-up"} color={palette.white} />}</Touch></View>
      <Text style={s.composerNote}>{props.pending ? "Vérifier l’envoi avec ↻" : props.body.length ? `${props.body.length}/1600 · ${props.segments} SMS estimé${props.segments > 1 ? "s" : ""}` : "SMS"}</Text>
    </View>
  </View>;
}

const s = StyleSheet.create({
  loading: { padding: 32, alignItems: "center", gap: 10 },
  filterBadge: { borderRadius: 4, paddingHorizontal: 5, backgroundColor: palette.green },
  filterCount: { fontSize: 10, fontWeight: "500", color: palette.accent },
  unreadTitle: { fontWeight: "600" },
  preview: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 6 },
  previewText: { flex: 1, color: palette.muted, fontSize: 13, lineHeight: 19 },
  threadTop: { paddingHorizontal: 22, gap: 8, paddingBottom: 10 },
  recipient: { marginBottom: 0 },
  threadNumber: { color: palette.muted, fontSize: 12 },
  lineLabel: { color: palette.muted, fontSize: 11, textAlign: "center", paddingVertical: 3 },
  status: { padding: 12, flexDirection: "row", gap: 8, justifyContent: "center" },
  error: { paddingHorizontal: 24, paddingBottom: 8 },
  timeline: { paddingHorizontal: 20, paddingVertical: 8 },
  olderControls: { paddingVertical: 4, gap: 6 },
  day: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 22 },
  dayRule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: palette.line },
  dayText: { color: palette.muted, fontSize: 10, fontWeight: "400" },
  bubble: { marginBottom: 9 },
  failedBubble: { borderWidth: StyleSheet.hairlineWidth, borderColor: palette.red, backgroundColor: palette.redLight },
  callEvent: { alignSelf: "center", width: "94%", flexDirection: "row", gap: 10, alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, backgroundColor: palette.white, borderRadius: 10, borderWidth: 1, borderColor: palette.line, marginVertical: 8 },
  missedCall: { borderColor: "#EEDBDB", backgroundColor: "#FDF9F9" },
  callIcon: { width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: palette.surface },
  callTitle: { color: palette.ink, fontWeight: "500", fontSize: 13 },
  emptyTimeline: { flexGrow: 1, paddingHorizontal: 24 },
  threadEmpty: { padding: 24, alignItems: "center", gap: 12 },
  emptyTitle: { color: palette.ink, fontSize: 18, fontWeight: "400", textAlign: "center" },
  emptyDetail: { color: palette.muted, fontSize: 14, lineHeight: 21, textAlign: "center" },
  composer: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12, backgroundColor: palette.white, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  composeRow: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  messageInput: { flex: 1, minHeight: 46, maxHeight: 126, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, borderRadius: 10, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, color: palette.ink, fontSize: 16 },
  send: { width: 46, height: 46, borderRadius: 10, backgroundColor: palette.accent, alignItems: "center", justifyContent: "center" },
  composerNote: { color: palette.muted, fontSize: 11, marginTop: 7, paddingLeft: 14 },
  pending: { color: palette.muted, fontSize: 12, lineHeight: 18, marginBottom: 10 },
});
