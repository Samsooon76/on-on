import { useFonts } from "expo-font";
import { AmbientBackground } from "./src/theme";
import { createClient, type Session } from "@supabase/supabase-js";
import mobilePackage from "./package.json";
import { ApiClientError, buildInbox, createApiClient, createSnapshot, getSmsSegmentInfo, phoneKey, type ApiPage, type CallRecord, type Contact, type Conversation, type InboxConversation } from "@onoff/api-client";
import { createNativeVoiceClient, type NativeAudioRoute, type NativeVoiceClient } from "@onoff/voice-native";
import * as SecureStore from "expo-secure-store";
import * as Linking from "expo-linking";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SafeAreaProvider, SafeAreaView, initialWindowMetrics, useSafeAreaInsets } from "react-native-safe-area-context";
import { TagManager } from "./src/Tags";
import { CallTranscript } from "./src/CallTranscript";
import { CallScreen } from "./src/CallScreen";
import type { TranscriptTarget } from "@onoff/api-client";
import { Dialer } from "./src/Dialer";
import { ConversationInbox, ConversationThread } from "./src/Conversations";
import { mergeRecords } from "./src/conversation-model";
import { loadLineHistory } from "./src/line-history";
import { useConversationHistory } from "./src/useConversationHistory";
import { clearSnapshot, loadSnapshot, saveSnapshot, snapshotSignature } from "./src/workspace-snapshot";
import { callStatusLabel, getPhoneCountry, isDialableNumber, isMissedCall, normalizePhone, phoneCountries, relativeCallDate } from "./src/phone";
import { ActionButton, Card, Empty, Icon, IconButton, MotionPreferences, Pill, SearchField, SectionTitle, Sheet, Touch, feedback, palette, styles, type IconName } from "./src/ui";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  Text,
  TextInput,
  View,
} from "react-native";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const apiBase = (process.env.EXPO_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");
const iosPersonalTeamPreview = Platform.OS === "ios" && process.env.EXPO_PUBLIC_IOS_LOCAL_NO_PUSH === "1";
const secureStorage = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};
const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, {
      auth: { storage: secureStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
    })
  : null;

type Tab = "calls" | "contacts" | "conversations" | "settings";
type Organization = { organization_id: string; role: "admin" | "member"; organizations: { id: string; name: string } | null };
type PendingSms = { message_id: string; organization_id: string; conversation_id: string; line_id: string; destination: string; body: string; idempotency_key: string };
type LineAssignment = { can_voice: boolean; can_sms: boolean; status?: string; lines: { id: string; organization_id: string; phone_number: string; voice_enabled: boolean; sms_enabled: boolean } | null };
type DeviceRecord = { id: string; organization_id: string; platform: string; label: string; status: string; last_active_at: string | null; created_at: string };
type VoiceDiagnosticEvent = "voice_registration_failed" | "history_refresh_succeeded" | "history_refresh_failed";
const tabs: { id: Tab; label: string; icon: IconName; activeIcon: IconName }[] = [
  { id: "conversations", label: "Conversations", icon: "chatbubbles-outline", activeIcon: "chatbubbles" },
  { id: "calls", label: "Appels", icon: "call-outline", activeIcon: "call" },
  { id: "contacts", label: "Contacts", icon: "people-outline", activeIcon: "people" },
  { id: "settings", label: "Réglages", icon: "settings-outline", activeIcon: "settings" },
];
const voiceRegistrationRefreshMs = 50 * 60 * 1000;

function actionKey(): string {
  const bytes = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  return bytes.join("");
}

function friendlyError(error: unknown): string {
  return error instanceof Error ? error.message : "Une erreur inattendue est survenue.";
}

// Work that runs alongside something else: its failure is kept and reported when the caller is ready for it,
// so an error that comes early is never an unhandled rejection.
function settle(work: Promise<unknown>): Promise<{ error: unknown } | null> {
  return work.then(() => null, (error: unknown) => ({ error }));
}

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    Inter400: require("@onoff/design-tokens/assets/Inter-400.ttf"),
    Inter500: require("@onoff/design-tokens/assets/Inter-500.ttf"),
    Inter600: require("@onoff/design-tokens/assets/Inter-600.ttf"),
    Inter700: require("@onoff/design-tokens/assets/Inter-700.ttf"),
  });
  if (!fontsLoaded && !fontError) return <View style={styles.center}><ActivityIndicator accessibilityLabel="Chargement de l’application" color={palette.accent} /></View>;
  return <SafeAreaProvider initialMetrics={initialWindowMetrics}><MotionPreferences><MobileApp /></MotionPreferences></SafeAreaProvider>;
}

function MobileApp() {
  const insets = useSafeAreaInsets();
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [recoveringPassword, setRecoveringPassword] = useState(false);
  const [authError, setAuthError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selectedOrg, setSelectedOrg] = useState("");
  const [lines, setLines] = useState<LineAssignment[]>([]);
  const [selectedLineId, setSelectedLineId] = useState("");
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactSearch, setContactSearch] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [inboxCursors, setInboxCursors] = useState<{ calls: string | null; conversations: string | null }>({ calls: null, conversations: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [recipientEditable, setRecipientEditable] = useState(false);
  const [messageDestination, setMessageDestination] = useState("");
  const [messageBody, setMessageBody] = useState("");
  const [pendingSmsAttempt, setPendingSmsAttempt] = useState<{ signature: string; key: string } | null>(null);
  const [smsRecoveryState, setSmsRecoveryState] = useState<"checking" | "ready" | "unavailable">("checking");
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("conversations");
  const [destination, setDestination] = useState("");
  const [callNumber, setCallNumber] = useState("");
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [providerCallSid, setProviderCallSid] = useState("");
  const [transcriptTarget, setTranscriptTarget] = useState<TranscriptTarget | null>(null);
  useEffect(() => { setTranscriptTarget(null); setProviderCallSid(""); }, [session?.user.id, selectedOrg, selectedLineId]);
  const [voiceStatus, setVoiceStatus] = useState("Ligne inactive");
  const [callStatus, setCallStatus] = useState<"idle" | "connecting" | "ringing" | "active" | "reconnecting">("idle");
  const [incomingNumber, setIncomingNumber] = useState("");
  const [muted, setMuted] = useState(false);
  const [canReceiveNativeCalls, setCanReceiveNativeCalls] = useState(false);
  const [audioDevices, setAudioDevices] = useState<NativeAudioRoute[]>([]);
  const [selectedAudioDevice, setSelectedAudioDevice] = useState("");
  const [keypadVisible, setKeypadVisible] = useState(false);
  const [dialerVisible, setDialerVisible] = useState(false);
  const [contactFormVisible, setContactFormVisible] = useState(false);
  const [messageComposerVisible, setMessageComposerVisible] = useState(false);
  const [callSearch, setCallSearch] = useState("");
  const [callFilter, setCallFilter] = useState<"all" | "missed">("all");
  const [refreshing, setRefreshing] = useState(false);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  // The inbox on screen comes from the device snapshot: the server has not confirmed it yet.
  const [showingSnapshot, setShowingSnapshot] = useState(false);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const contactSearchRef = useRef(contactSearch);
  contactSearchRef.current = contactSearch;
  const voiceRef = useRef<NativeVoiceClient | null>(null);
  const smsSegmentInfo = getSmsSegmentInfo(messageBody.trim());
  const deviceRef = useRef<DeviceRecord | null>(null);
  const voiceTokenRef = useRef("");
  const voiceRegistrationRef = useRef(false);
  const registeredUserRef = useRef("");

  const authToken = session?.access_token;
  const getCallAudioSource = useCallback((callId: string) => ({ uri: `${apiBase}/v1/calls/${encodeURIComponent(callId)}/recording/audio`, headers: { authorization: `Bearer ${authToken}` } }), [authToken]);
  const apiClient = useMemo(() => createApiClient({ baseUrl: apiBase, getAccessToken: () => authToken }), [authToken]);
  const activeAssignment = useMemo(
    () => lines.find((item) => item.lines?.id === selectedLineId) ?? lines.find((item) => item.lines) ?? null,
    [lines, selectedLineId],
  );
  const activeLine = activeAssignment?.lines ?? null;
  const defaultPhoneCountry = getPhoneCountry(activeLine?.phone_number ?? "") ?? "BE";
  const defaultPhoneCallingCode = phoneCountries.find((country) => country.code === defaultPhoneCountry)?.callingCode ?? "+32";
  const normalizedContactPhone = normalizePhone(contactPhone, defaultPhoneCountry);
  const duplicateContact = normalizedContactPhone
    ? contacts.find((contact) => contact.contact_phones.some((phone) => phone.phone_number === normalizedContactPhone))
    : undefined;
  const api = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    if (!apiBase) throw new Error("Configurez EXPO_PUBLIC_API_BASE_URL dans apps/mobile/.env.");
    return apiClient.request<T>(path, init);
  }, [apiClient]);
  const inbox = useMemo(() => buildInbox(selectedLineId, conversations, calls), [selectedLineId, conversations, calls]);
  const selectedThread = inbox.find((thread) => phoneKey(thread.remoteNumber) === phoneKey(normalizePhone(messageDestination, defaultPhoneCountry)));
  const matchingContacts = contacts.filter((contact) => contact.contact_phones.some((phone) => phoneKey(phone.phone_number) === phoneKey(normalizePhone(messageDestination, defaultPhoneCountry))));
  const selectedConversationContactName = selectedThread?.name ?? (matchingContacts.length === 1 ? matchingContacts[0]?.display_name : null);
  const markConversationRead = useCallback((id: string) => {
    setConversations((current) => current.map((conversation) => conversation.id === id ? { ...conversation, unread: false } : conversation));
  }, []);
  const history = useConversationHistory(api, selectedLineId, selectedConversationId, activeTab === "conversations" && messageComposerVisible, markConversationRead, session?.user.id);
  const historyRefreshRef = useRef(history.refresh);
  historyRefreshRef.current = history.refresh;
  const workspaceRequestRef = useRef(0);
  const workspaceSelection = useRef({ organizationId: "", lineId: "" });
  const loadedLineRef = useRef("");
  // The workspace request that finished without error: a single list may be refreshed alone only after that.
  const settledRequestRef = useRef(-1);
  // Last contacts list requested for an organization and search, so the search effect doesn't fetch it again.
  const contactsRequestRef = useRef({ organizationId: "", query: "", startedAt: 0 });
  // The server's organizations were received: the snapshot must not replace anything fresher.
  const serverStateRef = useRef(false);
  const savedSnapshotRef = useRef("");
  const inboxAccessRef = useRef({ canSms: false, canVoice: false });
  inboxAccessRef.current = { canSms: Boolean(activeAssignment?.can_sms), canVoice: Boolean(activeAssignment?.can_voice) };
  const reportVoiceDiagnostic = useCallback(async (event: VoiceDiagnosticEvent, durationMs?: number): Promise<void> => {
    try {
      await api("/v1/diagnostics/voice", {
        method: "POST",
        body: JSON.stringify({ event, platform: Platform.OS, appVersion: mobilePackage.version, ...(durationMs === undefined ? {} : { durationMs }) }),
      });
    } catch { /* Diagnostics must never interrupt calling or history refresh. */ }
  }, [api]);
  const reportVoiceDiagnosticRef = useRef(reportVoiceDiagnostic);
  reportVoiceDiagnosticRef.current = reportVoiceDiagnostic;

  const refreshWorkspace = useCallback(async (orgId: string, preferredLineId?: string) => {
    if (!orgId) return;
    const request = ++workspaceRequestRef.current;
    const context = { ...workspaceContextRef.current };
    workspaceSelection.current = { organizationId: orgId, lineId: context.lineId };
    const isCurrent = () => request === workspaceRequestRef.current && orgId === workspaceContextRef.current.organizationId;
    const query = contactSearchRef.current;
    const contactsPath = `/v1/organizations/${orgId}/contacts?limit=50${query ? `&q=${encodeURIComponent(query)}` : ""}`;
    contactsRequestRef.current = { organizationId: orgId, query, startedAt: Date.now() };
    const lineRequest = api<{ items: LineAssignment[] }>(`/v1/organizations/${orgId}/lines`);
    // Contacts and devices are applied when they arrive and never delay the inbox.
    const contactsOutcome = settle(api<{ items: Contact[] }>(contactsPath)
      .then(({ items }) => { if (isCurrent() && query === contactSearchRef.current) setContacts(items); }));
    const devicesOutcome = settle(api<{ items: DeviceRecord[] }>("/v1/devices")
      .then(({ items }) => { if (isCurrent()) setDevices(items); }));
    // Resolves once everything has settled, and fails if any required request failed.
    const finish = async (outcomes: ReturnType<typeof settle>[]) => {
      const failure = (await Promise.all(outcomes)).find(Boolean);
      if (failure) throw failure.error;
      if (request === workspaceRequestRef.current) settledRequestRef.current = request;
    };
    const lineResponse = await lineRequest;
    if (!isCurrent() || context.lineId !== workspaceContextRef.current.lineId) return;
    setLines(lineResponse.items);
    setShowingSnapshot(false);
    const target = lineResponse.items.find((item) => item.lines?.id === (preferredLineId ?? context.lineId))
      ?? lineResponse.items.find((item) => item.lines);
    const targetLineId = target?.lines?.id ?? "";
    if (targetLineId !== context.lineId) {
      loadedLineRef.current = "";
      setCalls([]);
      setConversations([]);
      setInboxCursors({ calls: null, conversations: null });
      setSelectedConversationId("");
      setMessageComposerVisible(false);
    }
    // The line selected by this request is already loading; don't reload it in the selection effect.
    workspaceSelection.current = { organizationId: orgId, lineId: targetLineId };
    setSelectedLineId(targetLineId);
    if (!targetLineId || !target) {
      loadedLineRef.current = "";
      setInboxCursors({ calls: null, conversations: null });
      setCalls([]);
      setConversations([]);
      setSelectedConversationId("");
      setMessageComposerVisible(false);
      await finish([contactsOutcome, devicesOutcome]);
      return;
    }
    const sameLine = loadedLineRef.current === targetLineId;
    // The selection above only reaches workspaceContextRef once React renders, which an empty page can beat.
    const isTargetCurrent = () => isCurrent() && [context.lineId, targetLineId, ""].includes(workspaceContextRef.current.lineId);
    // Each list is applied as soon as its page arrives. The line counts as loaded once both were applied, so a
    // request interrupted between the two never leaves a half-loaded line that the next refresh would merge into.
    let applied = 0;
    const markApplied = () => { if (++applied === 2) loadedLineRef.current = targetLineId; };
    const historyOutcome = settle(loadLineHistory(api, targetLineId, target, {
      onConversations: (page) => {
        if (!isTargetCurrent()) return;
        setConversations((current) => sameLine && target.can_sms ? mergeRecords(current, page.items) : page.items);
        setInboxCursors((current) => ({ ...current, conversations: target.can_sms ? (sameLine ? current.conversations : page.nextCursor) : null }));
        markApplied();
      },
      onCalls: (page) => {
        if (!isTargetCurrent()) return;
        setCalls((current) => sameLine && target.can_voice ? mergeRecords(current, page.items) : page.items);
        setInboxCursors((current) => ({ ...current, calls: target.can_voice ? (sameLine ? current.calls : page.nextCursor) : null }));
        markApplied();
      },
    }));
    await finish([contactsOutcome, devicesOutcome, historyOutcome]);
  }, [api]);

  async function restorePendingSmsAttempt(isCurrent: () => boolean = () => true, prefetched?: PendingSms[]): Promise<void> {
    const items = prefetched ?? (await api<{ items: PendingSms[] }>("/v1/messages/pending")).items;
    if (!isCurrent()) return;
    const pending = items[0];
    if (!pending) return;
    const requestBody = { organizationId: pending.organization_id, lineId: pending.line_id, destination: pending.destination, body: pending.body };
    setPendingSmsAttempt({ signature: JSON.stringify(requestBody), key: pending.idempotency_key });
    setSelectedOrg(pending.organization_id);
    setMessageDestination(pending.destination);
    setMessageBody(pending.body);
    await refreshWorkspace(pending.organization_id, pending.line_id);
    if (!isCurrent()) return;
    setSelectedLineId(pending.line_id);
    setSelectedConversationId(pending.conversation_id);
    setActiveTab("conversations");
    setMessageComposerVisible(true);
    setNotice("Un SMS précédent attend une vérification. Reprenez-la avant tout nouvel envoi.");
  }

  async function retrySmsRecovery(): Promise<void> {
    setSmsRecoveryState("checking");
    try {
      await restorePendingSmsAttempt();
      setSmsRecoveryState("ready");
    } catch {
      setSmsRecoveryState("unavailable");
      setNotice("Les SMS à vérifier ne sont pas disponibles. Vérifiez la connexion puis réessayez.");
    }
  }

  const markVoiceState = useCallback(async (registered: boolean) => {
    voiceRegistrationRef.current = registered;
    const device = deviceRef.current;
    if (!device || !authToken) return;
    try {
      await api(`/v1/devices/${device.id}/voice-state`, { method: "PUT", body: JSON.stringify({ registered }) });
    } catch (error) {
      if (registered) setNotice(friendlyError(error));
    }
  }, [api, authToken]);
  const markVoiceStateRef = useRef(markVoiceState);
  const refreshWorkspaceRef = useRef(refreshWorkspace);
  const workspaceContextRef = useRef({ organizationId: selectedOrg, lineId: selectedLineId });
  markVoiceStateRef.current = markVoiceState;
  refreshWorkspaceRef.current = refreshWorkspace;
  workspaceContextRef.current = { organizationId: selectedOrg, lineId: selectedLineId };

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true);
      return;
    }
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    }).catch(() => setAuthReady(true));
    const { data: auth } = supabase.auth.onAuthStateChange((event, nextSession) => {
      const previousUserId = registeredUserRef.current;
      if (previousUserId && previousUserId !== nextSession?.user.id) {
        const registeredToken = voiceTokenRef.current;
        void markVoiceStateRef.current(false);
        if (registeredToken) void voiceRef.current?.unregister(registeredToken).catch(() => undefined);
        voiceRegistrationRef.current = false;
        voiceTokenRef.current = "";
        deviceRef.current = null;
        setCanReceiveNativeCalls(false);
      }
      registeredUserRef.current = nextSession?.user.id ?? "";
      setSession(nextSession);
      if (event === "PASSWORD_RECOVERY") setRecoveringPassword(true);
      if (previousUserId && previousUserId !== nextSession?.user.id) {
        // Phone numbers and message previews of the previous user must not stay on the device.
        void clearSnapshot(previousUserId);
        serverStateRef.current = false;
        savedSnapshotRef.current = "";
        setShowingSnapshot(false);
        loadedLineRef.current = "";
        workspaceRequestRef.current += 1;
        setInboxCursors({ calls: null, conversations: null });
        setLoadingMore(false);
        setOrganizations([]);
        setLines([]);
        setContacts([]);
        setCalls([]);
        setConversations([]);
        setDevices([]);
        setSelectedOrg("");
        setSelectedLineId("");
        setSelectedConversationId("");
        setPendingSmsAttempt(null);
        setSmsRecoveryState("checking");
        setDialerVisible(false);
        setContactFormVisible(false);
        setMessageComposerVisible(false);
        setDestination("");
        setMessageDestination("");
        setMessageBody("");
        setContactSearch("");
        setContactName("");
        setContactPhone("");
        setContactEmail("");
        setCallSearch("");
      }
    });
    return () => auth.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!supabase) return;
    const handleUrl = async (url: string) => {
      const parsed = Linking.parse(url);
      const fragment = url.split("#")[1] ?? "";
      const fragmentParams = new URLSearchParams(fragment);
      const code = typeof parsed.queryParams?.code === "string" ? parsed.queryParams.code : "";
      if (code) await supabase.auth.exchangeCodeForSession(code);
      else {
        const accessToken = fragmentParams.get("access_token") ?? (typeof parsed.queryParams?.access_token === "string" ? parsed.queryParams.access_token : "");
        const refreshToken = fragmentParams.get("refresh_token") ?? (typeof parsed.queryParams?.refresh_token === "string" ? parsed.queryParams.refresh_token : "");
        if (accessToken && refreshToken) await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      }
    };
    void Linking.getInitialURL().then((url) => url ? handleUrl(url) : undefined).catch((error: unknown) => setAuthError(friendlyError(error)));
    const subscription = Linking.addEventListener("url", ({ url }) => {
      void handleUrl(url).catch((error: unknown) => setAuthError(friendlyError(error)));
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const voice = createNativeVoiceClient(Platform.OS === "ios" ? "ios" : "android", !iosPersonalTeamPreview);
    voiceRef.current = voice;
    const unsubscribe = voice.subscribe((event) => {
      switch (event.type) {
        case "ready":
          setVoiceStatus("Prête à recevoir les appels");
          void markVoiceStateRef.current(true);
          break;
        case "unavailable":
          setVoiceStatus(event.message);
          setNotice(event.message);
          void markVoiceStateRef.current(false);
          break;
        case "incoming":
          setIncomingNumber(event.from);
          setCallNumber(event.from);
          setConnectedAt(null);
          setCallStatus("ringing");
          break;
        case "connecting": setProviderCallSid(""); setIncomingNumber(""); setConnectedAt(null); setCallStatus("connecting"); break;
        case "ringing": setCallStatus("ringing"); break;
        case "active":
          setProviderCallSid(event.providerCallSid ?? "");
          setConnectedAt((current) => current ?? Date.now());
          setIncomingNumber(""); setCallStatus("active");
          break;
        case "reconnected":
          setIncomingNumber("");
          setConnectedAt((current) => current ?? Date.now());
          setCallStatus("active");
          break;
        case "reconnecting": setCallStatus("reconnecting"); break;
        case "ended":
          setIncomingNumber("");
          setCallNumber("");
          setConnectedAt(null);
          setCallStatus("idle");
          setMuted(false);
          setKeypadVisible(false);
          if (workspaceContextRef.current.organizationId) {
            const refreshStartedAt = Date.now();
            void refreshWorkspaceRef.current(workspaceContextRef.current.organizationId, workspaceContextRef.current.lineId)
              .then(() => reportVoiceDiagnosticRef.current("history_refresh_succeeded", Date.now() - refreshStartedAt))
              .catch(() => reportVoiceDiagnosticRef.current("history_refresh_failed", Date.now() - refreshStartedAt));
          }
          break;
        case "muted": setMuted(event.muted); break;
      }
    });
    voice.setAudioRouteListener(({ devices: routes, selectedId }) => {
      setAudioDevices(routes);
      setSelectedAudioDevice(selectedId ?? "");
    });
    const restoreNativeCall = () => {
      void voice.restoreCallState().catch((error: unknown) => setNotice(friendlyError(error)));
    };
    restoreNativeCall();
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") restoreNativeCall();
    });
    return () => {
      appState.remove();
      unsubscribe();
      void voice.destroy();
      voiceRef.current = null;
    };
  // The voice adapter lives for the authenticated app session, not an individual screen.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!authToken) {
      setSmsRecoveryState("checking");
      setPendingSmsAttempt(null);
      return;
    }
    let cancelled = false;
    setWorkspaceLoading(true);
    setSmsRecoveryState("checking");
    const pendingRequest = api<{ items: PendingSms[] }>("/v1/messages/pending")
      .then(result => ({ ...result, ok: true as const }), error => ({ items: [] as PendingSms[], ok: false as const, error }));
    void (async () => {
      const [{ items }, pending] = await Promise.all([
        api<{ items: Organization[] }>("/v1/organizations"),
        pendingRequest,
      ]);
      if (cancelled) return;
      setOrganizations(items);
      serverStateRef.current = true;
      // The organization on screen may come from the snapshot, which this closure predates.
      const shown = workspaceContextRef.current.organizationId;
      const next = shown && items.some((item) => item.organization_id === shown)
        ? shown
        : items[0]?.organization_id ?? "";
      if (pending.items.length) await restorePendingSmsAttempt(() => !cancelled, pending.items);
      else {
        setSelectedOrg(next);
        // Nothing uncertain to recover: conversations are usable while the history finishes loading.
        if (pending.ok) setSmsRecoveryState("ready");
        if (next) await refreshWorkspace(next);
        else {
          // No organization left: nothing of the snapshot may stay on screen.
          loadedLineRef.current = "";
          setShowingSnapshot(false);
          setLines([]);
          setSelectedLineId("");
          setCalls([]);
          setConversations([]);
          setInboxCursors({ calls: null, conversations: null });
        }
      }
      if (!pending.ok) throw pending.error;
      if (!cancelled) setSmsRecoveryState("ready");
    })().catch(() => {
      if (cancelled) return;
      setSmsRecoveryState("unavailable");
      setNotice("Les SMS à vérifier ne sont pas disponibles. Vérifiez la connexion puis réessayez.");
    }).finally(() => { if (!cancelled) setWorkspaceLoading(false); });
    return () => { cancelled = true; };
  // Load organizations whenever the authenticated identity changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  useEffect(() => {
    if (!authToken || !selectedOrg) return;
    if (workspaceSelection.current.organizationId === selectedOrg && workspaceSelection.current.lineId === selectedLineId) return;
    const request = workspaceRequestRef.current + 1;
    setWorkspaceLoading(true);
    void refreshWorkspace(selectedOrg, selectedLineId)
      .catch((error: unknown) => { if (request === workspaceRequestRef.current) setNotice(friendlyError(error)); })
      .finally(() => { if (request === workspaceRequestRef.current) setWorkspaceLoading(false); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrg, selectedLineId]);

  // Cold start: show this user's last known inbox before anything is fetched. It only fills empty state and starts
  // no request by itself (the effects that fetch wait for `showingSnapshot`): the normal load then replaces it.
  useEffect(() => {
    const userId = session?.user.id;
    if (!userId) return;
    let cancelled = false;
    void loadSnapshot<Organization, LineAssignment>(userId).then((snapshot) => {
      if (cancelled || !snapshot || serverStateRef.current || workspaceContextRef.current.organizationId) return;
      workspaceSelection.current = { organizationId: snapshot.organizationId, lineId: snapshot.lineId };
      setOrganizations(snapshot.organizations);
      setSelectedOrg(snapshot.organizationId);
      setLines(snapshot.lines);
      setSelectedLineId(snapshot.lineId);
      setConversations(snapshot.conversations);
      setCalls(snapshot.calls);
      setShowingSnapshot(true);
    });
    return () => { cancelled = true; };
  }, [session?.user.id]);

  // Remember the loaded inbox for the next cold start; identical content is not written again.
  useEffect(() => {
    const userId = session?.user.id;
    if (!authToken || !userId || workspaceLoading || showingSnapshot || !selectedOrg || !selectedLineId || !lines.length || loadedLineRef.current !== selectedLineId) return;
    const timer = setTimeout(() => {
      if (registeredUserRef.current !== userId) return;
      const snapshot = createSnapshot({ userId, organizationId: selectedOrg, lineId: selectedLineId, organizations, lines, conversations, calls });
      const signature = snapshotSignature(snapshot);
      if (signature === savedSnapshotRef.current) return;
      void saveSnapshot(snapshot).then((saved) => { if (saved && registeredUserRef.current === userId) savedSnapshotRef.current = signature; });
    }, 1000);
    return () => clearTimeout(timer);
  }, [authToken, session?.user.id, workspaceLoading, showingSnapshot, selectedOrg, selectedLineId, organizations, lines, conversations, calls]);

  useEffect(() => {
    if (messageComposerVisible && selectedThread?.smsConversationId && !selectedConversationId) {
      setSelectedConversationId(selectedThread.smsConversationId);
    }
  }, [messageComposerVisible, selectedThread?.smsConversationId, selectedConversationId]);

  useEffect(() => {
    if (!authToken || !selectedOrg || showingSnapshot) return;
    // The workspace load fetches the contacts too: don't request the same list again right after it.
    const requestedRecently = () => {
      const last = contactsRequestRef.current;
      return last.organizationId === selectedOrg && last.query === contactSearch && Date.now() - last.startedAt < 3000;
    };
    if (requestedRecently()) { setContactsLoading(false); return; }
    const controller = new AbortController();
    setContactsLoading(true);
    const timer = setTimeout(() => {
      if (requestedRecently()) { setContactsLoading(false); return; }
      contactsRequestRef.current = { organizationId: selectedOrg, query: contactSearch, startedAt: Date.now() };
      void api<{ items: Contact[] }>(`/v1/organizations/${selectedOrg}/contacts?limit=50${contactSearch ? `&q=${encodeURIComponent(contactSearch)}` : ""}`, { signal: controller.signal })
        .then(({ items }) => { if (!controller.signal.aborted) setContacts(items); })
        .catch((error: unknown) => { if (!controller.signal.aborted) setNotice(friendlyError(error)); })
        .finally(() => { if (!controller.signal.aborted) setContactsLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, authToken, selectedOrg, contactSearch, showingSnapshot]);

  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setKeyboardVisible(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useEffect(() => {
    if (callStatus !== "idle") { setDialerVisible(false); setContactFormVisible(false); }
  }, [callStatus]);

  useEffect(() => {
    if (!authToken || !selectedOrg || !selectedLineId || !supabase) return;
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const reportError = (error: unknown) => { if (!cancelled) setNotice(friendlyError(error)); };
    // Events within the delay share one refresh that covers what each of them asked for.
    const wanted = { everything: false, conversations: false, calls: false };
    // Only the newest first-page answer of a list is applied: an older one must not undo it.
    const latest = { conversations: 0, calls: 0 };
    const refresh = (need: Partial<typeof wanted>) => {
      if (cancelled) return;
      Object.assign(wanted, need);
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        const { canSms, canVoice } = inboxAccessRef.current;
        const conversations = wanted.conversations && canSms;
        const calls = wanted.calls && canVoice;
        // A list refreshed alone needs the line completely loaded and no load running (that load could bring older
        // pages than this one); otherwise the whole workspace is refreshed, as for every event before.
        const settled = loadedLineRef.current === selectedLineId && settledRequestRef.current === workspaceRequestRef.current;
        const everything = wanted.everything || ((conversations || calls) && !settled);
        wanted.everything = wanted.conversations = wanted.calls = false;
        const work: Promise<unknown>[] = [];
        if (everything) work.push(refreshWorkspace(selectedOrg, selectedLineId));
        else if (conversations || calls) {
          const request = workspaceRequestRef.current;
          const sequence = { conversations: conversations ? ++latest.conversations : 0, calls: calls ? ++latest.calls : 0 };
          const accepts = (list: keyof typeof latest) => !cancelled && sequence[list] === latest[list] && request === workspaceRequestRef.current
            && workspaceContextRef.current.organizationId === selectedOrg && workspaceContextRef.current.lineId === selectedLineId;
          work.push(loadLineHistory(api, selectedLineId, { can_sms: conversations, can_voice: calls }, {
            onConversations: conversations ? (page) => { if (accepts("conversations")) setConversations((current) => mergeRecords(current, page.items)); } : undefined,
            onCalls: calls ? (page) => { if (accepts("calls")) setCalls((current) => mergeRecords(current, page.items)); } : undefined,
          }));
        }
        if (everything || conversations) work.push(historyRefreshRef.current());
        void Promise.all(work).catch(reportError);
      }, 150);
    };
    const refreshFromEvent = (payload: unknown) => {
      if (cancelled || !payload || typeof payload !== "object") return;
      const event = (payload as { payload?: unknown }).payload ?? payload;
      if (!event || typeof event !== "object") return;
      const kind = (event as { kind?: unknown }).kind;
      if (kind === "contact") {
        const query = contactSearchRef.current;
        void api<{ items: Contact[] }>(`/v1/organizations/${selectedOrg}/contacts?limit=50${query ? `&q=${encodeURIComponent(query)}` : ""}`)
          .then(({ items }) => { if (!cancelled && query === contactSearchRef.current) setContacts(items); }).catch(reportError);
      } else if (kind === "device") {
        void api<{ items: DeviceRecord[] }>("/v1/devices")
          .then(({ items }) => { if (!cancelled) setDevices(items); }).catch(reportError);
      } else if (kind === "call") {
        refresh({ calls: true });
      } else if (kind === "message") {
        refresh({ conversations: true });
      }
    };
    void supabase.realtime.setAuth(authToken);
    const channels = [
      supabase.channel(`org:${selectedOrg}:contacts`, { config: { private: true } }),
      supabase.channel(`line:${selectedLineId}:voice`, { config: { private: true } }),
      supabase.channel(`line:${selectedLineId}:sms`, { config: { private: true } }),
      supabase.channel(`user:${session?.user.id ?? ""}:devices`, { config: { private: true } }),
    ];
    for (const channel of channels) {
      let subscribedBefore = false;
      channel.on("broadcast", { event: "onoff.activity" }, refreshFromEvent).subscribe((status) => {
        if (status === "SUBSCRIBED" && subscribedBefore) refresh({ everything: true });
        if (status === "SUBSCRIBED") subscribedBefore = true;
      });
    }
    const appState = AppState.addEventListener("change", (state) => { if (state === "active") refresh({ everything: true }); });
    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      appState.remove();
      for (const channel of channels) void supabase.removeChannel(channel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken, selectedOrg, selectedLineId]);

  useEffect(() => {
    // Permissions from the snapshot are not proof of access: the device registers once the server confirmed the line.
    if (showingSnapshot) return;
    if (!authToken || !selectedOrg || !activeLine?.id || activeLine.organization_id !== selectedOrg || !activeAssignment?.can_voice || !activeLine.voice_enabled) {
      setCanReceiveNativeCalls(false);
      if (voiceRegistrationRef.current) {
        const registeredToken = voiceTokenRef.current;
        void (async () => {
          await markVoiceState(false);
          if (registeredToken) await voiceRef.current?.unregister(registeredToken).catch(() => undefined);
        })();
      }
      setVoiceStatus("Ligne vocale inactive");
      return;
    }
    let cancelled = false;
    const platform = Platform.OS === "ios" ? "ios" : "android";
    void (async () => {
      if (voiceRegistrationRef.current && deviceRef.current?.organization_id !== selectedOrg) {
        const previousToken = voiceTokenRef.current;
        await markVoiceState(false);
        if (previousToken) await voiceRef.current?.unregister(previousToken).catch(() => undefined);
      }
      const cacheKey = `onoff.device.${session?.user.id}.${selectedOrg}.${platform}`;
      const cachedId = await SecureStore.getItemAsync(cacheKey);
      const devicesResponse = await api<{ items: DeviceRecord[] }>("/v1/devices");
      let device = devicesResponse.items.find((item) => item.id === cachedId && item.organization_id === selectedOrg && item.platform === platform && item.status === "active");
      if (!device) {
        device = await api<DeviceRecord>("/v1/devices", {
          method: "POST",
          body: JSON.stringify({ organizationId: selectedOrg, platform, label: `${Platform.OS} ${Platform.Version}`.slice(0, 80) }),
        });
        await SecureStore.setItemAsync(cacheKey, device.id);
      }
      if (cancelled) return;
      deviceRef.current = device;
      setDevices(devicesResponse.items.some((item) => item.id === device.id)
        ? devicesResponse.items
        : [device, ...devicesResponse.items]);
      const token = await api<{ token: string; incomingEnabled: boolean }>("/v1/voice/token", {
        method: "POST",
        body: JSON.stringify({ organizationId: selectedOrg, lineId: activeLine.id, deviceId: device.id }),
      });
      if (cancelled) return;
      voiceTokenRef.current = token.token;
      setCanReceiveNativeCalls(token.incomingEnabled && !iosPersonalTeamPreview);
      if (token.incomingEnabled && !iosPersonalTeamPreview && !voiceRegistrationRef.current) {
        const registrationStartedAt = Date.now();
        try {
          await voiceRef.current?.register(token.token, async () => token.token);
        } catch (error) {
          void reportVoiceDiagnosticRef.current("voice_registration_failed", Date.now() - registrationStartedAt);
          throw error;
        }
        await markVoiceState(true);
      } else if (!token.incomingEnabled && voiceRegistrationRef.current) {
        await markVoiceState(false);
        await voiceRef.current?.unregister(token.token).catch(() => undefined);
      }
      setVoiceStatus(iosPersonalTeamPreview
        ? "Appels sortants prêts ; appels entrants indisponibles avec ce compte Apple"
        : token.incomingEnabled ? "Appareil prêt pour les appels" : "Appels sortants prêts; le push entrant reste à configurer");
    })().catch((error: unknown) => {
      if (!cancelled) setVoiceStatus(friendlyError(error));
    });
    return () => { cancelled = true; };
  }, [activeAssignment?.can_voice, activeLine?.id, activeLine?.organization_id, activeLine?.voice_enabled, api, authToken, markVoiceState, selectedOrg, session?.user.id, showingSnapshot]);

  useEffect(() => {
    if (!authToken || !activeLine?.id || !activeAssignment?.can_voice || !canReceiveNativeCalls) return;
    let cancelled = false;
    let refreshInFlight = false;
    const refreshRegistration = () => {
      const device = deviceRef.current;
      const voice = voiceRef.current;
      if (cancelled || refreshInFlight || AppState.currentState !== "active" || !device || !voice) return;
      refreshInFlight = true;
      void (async () => {
        try {
          const { token, incomingEnabled } = await api<{ token: string; incomingEnabled: boolean }>("/v1/voice/token", {
            method: "POST",
            body: JSON.stringify({ organizationId: selectedOrg, lineId: activeLine.id, deviceId: device.id }),
          });
          if (cancelled || deviceRef.current?.id !== device.id || voiceRef.current !== voice) return;
          voiceTokenRef.current = token;
          if (incomingEnabled) {
            // Voice.register asks the native SDK to register with the latest APNs/FCM device token.
            // Refresh on resume and before the one-hour Access Token expires.
            const registrationStartedAt = Date.now();
            try {
              await voice.register(token, async () => token);
            } catch (error) {
              void reportVoiceDiagnosticRef.current("voice_registration_failed", Date.now() - registrationStartedAt);
              throw error;
            }
            if (cancelled || deviceRef.current?.id !== device.id || voiceRef.current !== voice) {
              await voice.unregister(token).catch(() => undefined);
              return;
            }
            await markVoiceState(true);
          } else {
            await markVoiceState(false);
            await voice.unregister(token).catch(() => undefined);
            if (!cancelled) setCanReceiveNativeCalls(false);
          }
        } catch (error) {
          if (!cancelled) {
            setNotice(friendlyError(error));
          }
        } finally {
          refreshInFlight = false;
        }
      })();
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshRegistration();
    });
    const interval = setInterval(refreshRegistration, voiceRegistrationRefreshMs);
    return () => {
      cancelled = true;
      subscription.remove();
      clearInterval(interval);
    };
  }, [activeAssignment?.can_voice, activeLine?.id, api, authToken, canReceiveNativeCalls, markVoiceState, selectedOrg]);

  async function signIn() {
    setBusy(true);
    setAuthError("");
    try {
      if (!supabase) throw new Error("Configuration Supabase manquante dans apps/mobile/.env.");
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
    } catch (error) {
      setAuthError(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function requestPasswordRecovery() {
    try {
      if (!supabase || !email.trim()) throw new Error("Saisissez votre adresse e-mail.");
      await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: Linking.createURL("/") });
      setAuthError("Vérifiez votre boîte mail pour réinitialiser le mot de passe.");
    } catch (error) {
      setAuthError(friendlyError(error));
    }
  }

  async function updatePassword() {
    try {
      if (!supabase || newPassword.length < 10) throw new Error("Choisissez un mot de passe d’au moins 10 caractères.");
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setRecoveringPassword(false);
      setNewPassword("");
      setAuthError("Mot de passe mis à jour.");
    } catch (error) {
      setAuthError(friendlyError(error));
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      if (deviceRef.current) await markVoiceState(false);
      if (voiceTokenRef.current) await voiceRef.current?.unregister(voiceTokenRef.current).catch(() => undefined);
      if (!supabase) return;
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      voiceRegistrationRef.current = false;
      voiceTokenRef.current = "";
      deviceRef.current = null;
      setSession(null);
    } catch (error) {
      setNotice(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function startCall(number = destination) {
    const normalized = normalizePhone(number, defaultPhoneCountry);
    if (busy || callStatus !== "idle") return;
    if (!activeLine?.voice_enabled || !activeAssignment?.can_voice || !deviceRef.current || !isDialableNumber(number, defaultPhoneCountry)) {
      setNotice("Choisissez une ligne vocale et vérifiez le numéro saisi.");
      return;
    }
    setDestination(normalized);
    setCallNumber(normalized);
    setConnectedAt(null);
    setBusy(true);
    let unusedIntentId: string | null = null;
    try {
      const intent = await api<{ id: string }>("/v1/call-intents", {
        method: "POST",
        headers: { "idempotency-key": actionKey() },
        body: JSON.stringify({ organizationId: selectedOrg, lineId: activeLine.id, deviceId: deviceRef.current.id, destination: normalized }),
      });
      unusedIntentId = intent.id;
      const token = (await api<{ token: string }>("/v1/voice/token", {
        method: "POST",
        body: JSON.stringify({ organizationId: selectedOrg, lineId: activeLine.id, deviceId: deviceRef.current.id }),
      })).token;
      voiceTokenRef.current = token;
      if (!voiceRef.current) throw new Error("Le service vocal n’est pas disponible sur cet appareil.");
      voiceRef.current.setAccessToken(token);
      await voiceRef.current.startCall({ destination: normalized, intentId: intent.id });
      unusedIntentId = null;
      setDestination(normalized);
      setDialerVisible(false);
      if (activeTab !== "conversations") setActiveTab("calls");
    } catch (error) {
      if (unusedIntentId) {
        try { await api(`/v1/call-intents/${unusedIntentId}/cancel`, { method: "POST" }); } catch { /* Server expiry remains the fallback. */ }
      }
      setNotice(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function changeAudioRoute() {
    const voice = voiceRef.current;
    if (!voice) return;
    try {
      if (Platform.OS === "ios") {
        await voice.showAudioRoutePicker();
        return;
      }
      await voice.selectNextAudioRoute();
      const next = await voice.getAudioRouteSnapshot();
      setAudioDevices(next.devices);
      setSelectedAudioDevice(next.selectedId ?? "");
    } catch (error) {
      setNotice(friendlyError(error));
    }
  }

  async function saveContact() {
    const phone = normalizePhone(contactPhone, defaultPhoneCountry);
    if (!selectedOrg || !contactName.trim()) return;
    if (contactPhone && !isDialableNumber(contactPhone, defaultPhoneCountry)) {
      setNotice(`Vérifiez le numéro avec l’indicatif ${defaultPhoneCallingCode}.`);
      return;
    }
    setBusy(true);
    try {
      await api(`/v1/organizations/${selectedOrg}/contacts`, {
        method: "POST",
        body: JSON.stringify({ displayName: contactName, email: contactEmail || undefined, phones: phone ? [{ phoneNumber: phone, label: "Mobile" }] : [] }),
      });
      setContactName("");
      setContactPhone("");
      setContactEmail("");
      setContactFormVisible(false);
      await refreshWorkspace(selectedOrg, selectedLineId);
    } catch (error) {
      setNotice(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function archiveContact(contactId: string) {
    try {
      await api(`/v1/contacts/${contactId}`, { method: "DELETE" });
      await refreshWorkspace(selectedOrg, selectedLineId);
    } catch (error) {
      setNotice(friendlyError(error));
    }
  }

  async function sendMessage() {
    if (smsRecoveryState !== "ready") {
      setNotice("Les envois SMS précédents doivent être vérifiés avant un nouvel envoi.");
      return;
    }
    if (!selectedOrg || !activeLine || !activeAssignment?.can_sms || !activeLine.sms_enabled) {
      setNotice("Cette ligne n’a pas de permission SMS.");
      return;
    }
    const normalized = normalizePhone(messageDestination, defaultPhoneCountry);
    if (!isDialableNumber(messageDestination, defaultPhoneCountry) || !messageBody.trim()) {
      setNotice("Vérifiez le numéro du destinataire et le contenu du message.");
      return;
    }
    const requestBody = { organizationId: selectedOrg, lineId: activeLine.id, destination: normalized, body: messageBody.trim() };
    const signature = JSON.stringify(requestBody);
    if (pendingSmsAttempt && pendingSmsAttempt.signature !== signature) {
      setNotice("Le SMS précédent a un résultat incertain. Vérifiez-le avant de modifier ou renvoyer le texte.");
      return;
    }
    const isRetry = Boolean(pendingSmsAttempt);
    const idempotencyKey = pendingSmsAttempt?.key ?? actionKey();
    if (!pendingSmsAttempt) setPendingSmsAttempt({ signature, key: idempotencyKey });
    setBusy(true);
    let result: { conversationId: string; status: string; submissionConfirmed?: boolean };
    try {
      result = await api<{ conversationId: string; status: string; submissionConfirmed?: boolean }>("/v1/messages", {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      if (!isRetry && error instanceof ApiClientError && error.status >= 400 && error.status < 500) setPendingSmsAttempt(null);
      setNotice(friendlyError(error));
      setBusy(false);
      return;
    }
    setMessageDestination(normalized);
    setSelectedConversationId(result.conversationId);
    setRecipientEditable(false);
    if (!result.submissionConfirmed && (result.status === "unknown" || result.status === "submitting")) {
      setNotice("L’envoi est en cours de vérification. Réessayez avec le même contenu pour lire son état, sans le renvoyer.");
    } else if (result.status === "failed" || result.status === "undelivered") {
      setPendingSmsAttempt(null);
      setNotice("Le fournisseur indique que le message n’a pas été remis. Vous pouvez le corriger ou le renvoyer.");
    } else {
      setPendingSmsAttempt(null);
      setMessageBody("");
      setNotice(result.status === "submitting" ? "Twilio a accepté le message; la remise est en attente." : "Message envoyé à Twilio.");
    }
    try {
      await refreshWorkspace(selectedOrg, selectedLineId);
      await historyRefreshRef.current();
    } catch { /* Keep the send result visible; the next refresh will reload persisted data. */ }
    setBusy(false);
  }

  async function revokeDevice(deviceId: string) {
    try {
      if (deviceRef.current?.id === deviceId) {
        const token = voiceTokenRef.current;
        await markVoiceState(false);
        if (token) await voiceRef.current?.unregister(token).catch(() => undefined);
        voiceRef.current?.hangUp();
        voiceRef.current?.rejectCall();
        voiceRegistrationRef.current = false;
        voiceTokenRef.current = "";
        deviceRef.current = null;
        setCanReceiveNativeCalls(false);
      }
      await api(`/v1/devices/${deviceId}/revoke`, { method: "POST" });
      setDevices((current) => current.map((device) => device.id === deviceId ? { ...device, status: "revoked" } : device));
    } catch (error) {
      setNotice(friendlyError(error));
    }
  }

  function selectOrganization(organizationId: string): void {
    if (smsRecoveryState !== "ready") {
      setNotice("Attendez la vérification des envois SMS avant de changer d’organisation.");
      return;
    }
    if (pendingSmsAttempt) {
      setNotice("Vérifiez d’abord le résultat du SMS avant de changer d’organisation.");
      return;
    }
    if (callStatus !== "idle") {
      setNotice("Terminez l’appel avant de changer d’organisation.");
      return;
    }
    if (organizationId === selectedOrg) return;
    setLines([]);
    setSelectedLineId("");
    setContacts([]);
    loadedLineRef.current = "";
    workspaceRequestRef.current += 1;
    setInboxCursors({ calls: null, conversations: null });
    setLoadingMore(false);
    setCalls([]);
    setConversations([]);
    setSelectedConversationId("");
    setDevices([]);
    setDestination("");
    setMessageDestination("");
    setMessageBody("");
    setMessageComposerVisible(false);
    setDialerVisible(false);
    setContactSearch("");
    setContactFormVisible(false);
    setContactName("");
    setContactPhone("");
    setContactEmail("");
    setSelectedOrg(organizationId);
  }

  function selectLine(lineId: string): void {
    if (smsRecoveryState !== "ready") {
      setNotice("Attendez la vérification des envois SMS avant de changer de ligne.");
      return;
    }
    if (pendingSmsAttempt) {
      setNotice("Vérifiez d’abord le résultat du SMS avant de changer de ligne.");
      return;
    }
    if (callStatus !== "idle") {
      setNotice("Terminez l’appel avant de changer de ligne.");
      return;
    }
    if (lineId === selectedLineId) return;
    setNotice("");
    loadedLineRef.current = "";
    workspaceRequestRef.current += 1;
    setInboxCursors({ calls: null, conversations: null });
    setLoadingMore(false);
    setCalls([]);
    setConversations([]);
    setSelectedConversationId("");
    setMessageComposerVisible(false);
    setMessageDestination("");
    setMessageBody("");
    setDialerVisible(false);
    setSelectedLineId(lineId);
  }

  const visibleCalls = useMemo(() => {
    const query = callSearch.trim().toLocaleLowerCase();
    return calls.filter((call) => (callFilter === "all" || isMissedCall(call)) && (!query || `${call.remoteContactName ?? ""} ${call.remote_number}`.toLocaleLowerCase().includes(query))).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [calls, callSearch, callFilter]);
  const callContactName = useMemo(() => {
    if (!callNumber) return "";
    return contacts.find((contact) => contact.contact_phones.some((phone) => normalizePhone(phone.phone_number) === normalizePhone(callNumber)))?.display_name ?? "";
  }, [callNumber, contacts]);
  const callAudioLabel = audioDevices.find((device) => device.id === selectedAudioDevice)?.name ?? "Appareil";
  const missedCount = calls.filter(isMissedCall).length;
  const unreadCount = conversations.filter((conversation) => conversation.unread).length;
  const canCall = Boolean(activeLine?.voice_enabled && activeAssignment?.can_voice && callStatus === "idle");
  const callUnavailableReason = !activeLine ? "Une ligne doit vous être attribuée pour passer un appel." : callStatus !== "idle" ? "Terminez l’appel en cours pour en lancer un autre." : "Les appels sont désactivés sur cette ligne. Contactez votre administrateur.";
  const smsLocked = Boolean(pendingSmsAttempt) || smsRecoveryState !== "ready";

  function openDialer(number?: string) {
    Keyboard.dismiss();
    if (callStatus !== "idle") { setKeypadVisible((value) => !value); return; }
    if (number !== undefined) setDestination(number);
    setNotice("");
    feedback();
    setDialerVisible(true);
  }

  function changeTab(tab: Tab) {
    Keyboard.dismiss();
    if (tab !== activeTab) feedback();
    setActiveTab(tab);
  }

  async function refreshCurrentWorkspace() {
    if (refreshing || !selectedOrg) return;
    setRefreshing(true);
    try { await refreshWorkspace(selectedOrg, selectedLineId); await historyRefreshRef.current(); }
    catch (error) { setNotice(friendlyError(error)); }
    finally { setRefreshing(false); }
  }

  async function loadMoreInbox() {
    if (loadingMore || refreshing || !selectedLineId) return;
    const lineId = selectedLineId;
    const request = workspaceRequestRef.current;
    setLoadingMore(true);
    try {
      const [callPage, conversationPage] = await Promise.all([
        activeAssignment?.can_voice && inboxCursors.calls ? api<ApiPage<CallRecord>>(`/v1/lines/${lineId}/calls?limit=50&cursor=${encodeURIComponent(inboxCursors.calls)}`) : null,
        activeAssignment?.can_sms && inboxCursors.conversations ? api<ApiPage<Conversation>>(`/v1/lines/${lineId}/conversations?limit=50&cursor=${encodeURIComponent(inboxCursors.conversations)}`) : null,
      ]);
      if (lineId !== workspaceContextRef.current.lineId || request !== workspaceRequestRef.current) return;
      if (callPage) setCalls((current) => mergeRecords(callPage.items, current));
      if (conversationPage) setConversations((current) => mergeRecords(conversationPage.items, current));
      setInboxCursors({ calls: callPage?.nextCursor ?? null, conversations: conversationPage?.nextCursor ?? null });
    } catch (error) { if (lineId === workspaceContextRef.current.lineId) setNotice(friendlyError(error)); }
    finally { if (lineId === workspaceContextRef.current.lineId) setLoadingMore(false); }
  }

  function newMessage(number = "") {
    const thread = inbox.find((item) => phoneKey(item.remoteNumber) === phoneKey(normalizePhone(number, defaultPhoneCountry)));
    openConversation(thread ?? { remoteNumber: number, smsConversationId: null }, !number);
  }

  function openConversation(conversation: Pick<InboxConversation, "remoteNumber" | "smsConversationId">, editable = false) {
    if (smsLocked) {
      setActiveTab("conversations");
      if (pendingSmsAttempt) setMessageComposerVisible(true);
      else setNotice("Attendez la vérification des envois précédents avant d’ouvrir une conversation.");
      return;
    }
    const sameRecipient = Boolean(conversation.remoteNumber) && phoneKey(normalizePhone(messageDestination, defaultPhoneCountry)) === phoneKey(normalizePhone(conversation.remoteNumber, defaultPhoneCountry));
    const open = () => {
      if (!sameRecipient) setMessageBody("");
      setSelectedConversationId(conversation.smsConversationId ?? "");
      setMessageDestination(conversation.remoteNumber);
      setRecipientEditable(editable);
      setNotice("");
      setMessageComposerVisible(true);
      setActiveTab("conversations");
      feedback();
    };
    if (messageBody.trim() && !sameRecipient) {
      Alert.alert("Changer de conversation ?", "Le brouillon actuel sera remplacé.", [
        { text: "Garder le brouillon", style: "cancel", onPress: () => { setActiveTab("conversations"); setMessageComposerVisible(true); } },
        { text: "Ouvrir la conversation", onPress: open },
      ]);
    } else open();
  }

  function changeMessageDestination(number: string) {
    setMessageDestination(number);
    const thread = inbox.find((item) => phoneKey(item.remoteNumber) === phoneKey(normalizePhone(number, defaultPhoneCountry)));
    setSelectedConversationId(thread?.smsConversationId ?? "");
  }

  const loading = <View style={{ padding: 40, alignItems: "center", gap: 12 }}><ActivityIndicator color={palette.accent} /><Text style={styles.rowMeta}>Chargement de votre espace…</Text></View>;
  const lineOverview = <Touch accessibilityLabel="Voir les réglages de votre ligne" style={styles.lineOverview} onPress={() => changeTab("settings")}>
    <View style={styles.lineIcon}><Icon name="phone-portrait-outline" color={palette.accent} /></View>
    <View style={styles.rowCopy}><Text style={styles.lineLabel}>{activeLine ? "Votre ligne professionnelle" : "Votre espace professionnel"}</Text><Text style={styles.lineNumber}>{activeLine?.phone_number ?? "Aucune ligne attribuée"}</Text></View>
    <Icon name="chevron-forward" size={17} color={palette.muted} />
  </Touch>;

  function renderTab(tab: typeof tabs[number]) {
    const selected = activeTab === tab.id;
    return <Touch key={tab.id} accessibilityRole="tab" accessibilityLabel={tab.label} accessibilityState={{ selected }} onPress={() => changeTab(tab.id)} style={styles.tab}>
      <View style={[styles.tabIcon, selected && { backgroundColor: palette.selected }]}><Icon name={tab.icon} size={21} color={selected ? palette.accent : palette.muted} /></View>
      {tab.id === "conversations" && unreadCount > 0 && <View style={styles.badge}><Text style={styles.badgeText}>{unreadCount > 9 ? "9+" : unreadCount}</Text></View>}
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.9} style={[styles.tabLabel, selected && styles.tabActive]}>{tab.label}</Text>
    </Touch>;
  }

  if (!authReady) return <View style={styles.center}><ActivityIndicator color={palette.accent} /><Text style={styles.muted}>Ouverture de votre espace…</Text></View>;
  if (!session || recoveringPassword) {
    return <SafeAreaView style={styles.authScreen}><AmbientBackground /><KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.authContent} keyboardShouldPersistTaps="handled">
        <View style={styles.authCard}>
          <View style={styles.brandMark}><Text style={styles.brandLetter}>o</Text></View>
          <Text style={styles.headerBrand}>ONOFF BUSINESS</Text>
          <Text style={styles.title}>{recoveringPassword ? "Nouveau mot de passe" : "Bienvenue"}</Text>
          <Text style={styles.body}>{recoveringPassword ? "Choisissez un mot de passe pour votre compte." : "Vos appels, vos messages et votre équipe. Tout simplement."}</Text>
          {!recoveringPassword && <>
            <TextInput accessibilityLabel="Adresse e-mail" style={styles.input} placeholder="Adresse e-mail" placeholderTextColor={palette.muted} autoCapitalize="none" autoComplete="email" keyboardType="email-address" value={email} onChangeText={setEmail} />
            <TextInput accessibilityLabel="Mot de passe" style={styles.input} placeholder="Mot de passe" placeholderTextColor={palette.muted} secureTextEntry autoComplete="current-password" value={password} onChangeText={setPassword} returnKeyType="go" onSubmitEditing={() => { if (!busy) void signIn(); }} />
          </>}
          {recoveringPassword && <TextInput accessibilityLabel="Nouveau mot de passe" style={styles.input} placeholder="Nouveau mot de passe" secureTextEntry value={newPassword} onChangeText={setNewPassword} />}
          {!!authError && <Text accessibilityRole="alert" style={[styles.hint, { color: palette.red, marginBottom: 12 }]}>{authError}</Text>}
          <ActionButton label={recoveringPassword ? "Mettre à jour" : "Se connecter"} icon="arrow-forward" loading={busy} onPress={() => void (recoveringPassword ? updatePassword() : signIn())} />
          {!recoveringPassword && <Touch style={styles.textButton} onPress={() => void requestPasswordRecovery()}><Text style={styles.textButtonLabel}>Mot de passe oublié ?</Text></Touch>}
          {recoveringPassword && <ActionButton label="Retour à la connexion" quiet onPress={() => setRecoveringPassword(false)} />}
          {!supabase && <Text style={styles.hint}>La connexion n’est pas encore configurée sur cet appareil.</Text>}
        </View>
      </ScrollView>
    </KeyboardAvoidingView></SafeAreaView>;
  }

  const isThread = activeTab === "conversations" && messageComposerVisible;
  const tabTitle = isThread ? (selectedConversationContactName ?? (messageDestination || "Nouvelle conversation")) : tabs.find((tab) => tab.id === activeTab)?.label ?? "Onoff";
  return <SafeAreaView style={styles.app} edges={["top", "left", "right"]}>
    <AmbientBackground />
    <StatusBar barStyle="dark-content" />
    {callStatus !== "idle" ? <CallScreen
      status={callStatus}
      incoming={Boolean(incomingNumber)}
      name={callContactName}
      number={callNumber}
      connectedAt={connectedAt}
      muted={muted}
      keypadVisible={keypadVisible}
      audioLabel={callAudioLabel}
      notice={notice}
      canTranscribe={Boolean(providerCallSid)}
      bottomInset={insets.bottom}
      onMute={() => voiceRef.current?.setMuted(!muted)}
      onKeypad={() => setKeypadVisible((shown) => !shown)}
      onAudio={() => void changeAudioRoute()}
      onDigit={(digit) => voiceRef.current?.sendDigits(digit)}
      onTranscribe={() => setTranscriptTarget({ providerCallSid })}
      onAccept={() => voiceRef.current?.acceptCall()}
      onDecline={() => voiceRef.current?.rejectCall()}
      onHangup={() => voiceRef.current?.hangUp()}
      onDismissNotice={() => setNotice("")}
    /> : <>
    <View style={styles.header}>
      {isThread && <IconButton icon="chevron-back" label="Revenir aux conversations" onPress={() => { Keyboard.dismiss(); setMessageComposerVisible(false); }} />}
      <View style={styles.rowCopy}><Text style={styles.headerBrand}>ONOFF BUSINESS</Text><Text accessibilityRole="header" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={[styles.headerTitle, isThread && { fontSize: 19, lineHeight: 26, letterSpacing: -0.3 }]}>{tabTitle}</Text></View>
      <View style={styles.headerActions}>
        {isThread && <IconButton icon="call-outline" label="Appeler cet interlocuteur" tone="accent" disabled={!canCall || busy || !isDialableNumber(messageDestination, defaultPhoneCountry)} onPress={() => openDialer(messageDestination)} />}
        {activeTab === "contacts" && <IconButton icon="add" label="Ajouter un contact" tone="accent" onPress={() => { setNotice(""); setContactFormVisible(true); }} />}
        {activeTab === "conversations" && !isThread && <IconButton icon="create-outline" label="Nouvelle conversation" tone="accent" onPress={() => newMessage()} disabled={smsLocked} />}
        {!isThread && activeTab !== "contacts" && <Touch style={styles.avatar} accessibilityLabel="Ouvrir les réglages du compte" onPress={() => changeTab("settings")}><View style={styles.avatarInitial}><Text style={styles.avatarText}>{session.user.email?.slice(0, 1).toUpperCase() ?? "O"}</Text></View></Touch>}
      </View>
    </View>
    {(organizations.length > 1 || lines.length > 1) && <View style={styles.selectors}>
      {organizations.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pills}>{organizations.filter((item) => item.organizations).map((item) => <Pill key={item.organization_id} selected={selectedOrg === item.organization_id} disabled={callStatus !== "idle" || smsLocked} label={item.organizations?.name ?? "Organisation"} onPress={() => selectOrganization(item.organization_id)} />)}</ScrollView>}
      {lines.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pills}>{lines.filter((item) => item.lines).map((item) => <Pill key={item.lines!.id} selected={activeLine?.id === item.lines!.id} disabled={callStatus !== "idle" || smsLocked} label={item.lines!.phone_number} onPress={() => selectLine(item.lines!.id)} />)}</ScrollView>}
    </View>}
    {!!notice && !dialerVisible && !contactFormVisible && <Pressable accessibilityRole="button" accessibilityLabel={`${notice}. Fermer le message`} onPress={() => setNotice("")} style={styles.notice}><Icon name="information-circle-outline" size={19} color={palette.red} /><Text accessibilityLiveRegion="polite" style={styles.noticeText}>{notice}</Text><Icon name="close" size={17} color={palette.red} /></Pressable>}
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={insets.top + (isThread ? 90 : 100)}>
      {activeTab === "calls" && <FlatList
        data={visibleCalls} keyExtractor={(item) => item.id} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" refreshing={refreshing} onRefresh={() => void refreshCurrentWorkspace()} initialNumToRender={12} windowSize={7}
        ListHeaderComponent={<View style={styles.listHeader}>{lineOverview}<View style={styles.segmentBar}>{(["all", "missed"] as const).map((filter) => <Touch key={filter} accessibilityRole="tab" accessibilityState={{ selected: callFilter === filter }} onPress={() => { feedback(); setCallFilter(filter); }} style={[styles.segment, callFilter === filter && styles.segmentActive]}><Text style={[styles.segmentText, callFilter === filter && styles.segmentTextActive]}>{filter === "all" ? "Tous les appels" : `Manqués${missedCount ? ` (${missedCount})` : ""}`}</Text></Touch>)}</View>{calls.length > 0 && <SearchField placeholder="Rechercher un nom ou un numéro" value={callSearch} onChangeText={setCallSearch} />}{visibleCalls.length > 0 && <Text style={styles.listCaption}>RÉCENTS</Text>}</View>}
        ListEmptyComponent={workspaceLoading ? loading : <Empty icon={callFilter === "missed" ? "checkmark-done-outline" : "call-outline"} title={callSearch ? "Aucun appel trouvé" : callFilter === "missed" ? "Vous n’avez rien manqué." : "Votre prochain échange\ncommence ici."} detail={callSearch ? "Essayez un autre nom ou un autre numéro." : callFilter === "missed" ? "Vos appels manqués seront regroupés ici pour les retrouver facilement." : "Composez un numéro ou retrouvez un contact. Vos appels récents apparaîtront ici."} action={callSearch ? "Effacer la recherche" : "Ouvrir le clavier"} onAction={() => callSearch ? setCallSearch("") : openDialer()} secondary="Voir mes contacts" onSecondary={() => changeTab("contacts")} />}
        renderItem={({ item }) => <Touch accessibilityLabel={`${item.remoteContactName ?? item.remote_number}, ${isMissedCall(item) ? "appel manqué" : item.direction === "outbound" ? "appel sortant" : "appel entrant"}. Ouvrir la conversation`} style={styles.listRow} onPress={() => newMessage(item.remote_number)}>
          <View style={[styles.roundIcon, isMissedCall(item) && styles.missedIcon]}><Icon name={isMissedCall(item) ? "call-outline" : item.direction === "outbound" ? "arrow-up-outline" : "arrow-down-outline"} color={isMissedCall(item) ? palette.red : palette.accent} size={21} /></View>
          <View style={styles.rowCopy}><Text numberOfLines={1} style={[styles.rowTitle, isMissedCall(item) && styles.missedText]}>{item.remoteContactName ?? item.remote_number}</Text><Text numberOfLines={1} style={styles.rowMeta}>{item.direction === "outbound" ? "Sortant" : "Entrant"} · {callStatusLabel(item.status)}{item.duration_seconds ? ` · ${Math.floor(item.duration_seconds / 60)}:${String(item.duration_seconds % 60).padStart(2, "0")}` : ""}</Text></View>
          <View style={styles.rowTrailing}><IconButton icon="document-text-outline" label="Tags et transcription de cet appel" onPress={() => setTranscriptTarget({ callId: item.id })} /><Text style={styles.rowDate}>{relativeCallDate(item.created_at)}</Text><Icon name="chevron-forward" size={17} color={palette.muted} /></View>
        </Touch>}
      />}
      {activeTab === "contacts" && <FlatList
        data={contacts} keyExtractor={(item) => item.id} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false} refreshing={refreshing} onRefresh={() => void refreshCurrentWorkspace()} initialNumToRender={12} windowSize={7}
        ListHeaderComponent={<View style={styles.listHeader}><SearchField placeholder="Rechercher dans les contacts" value={contactSearch} onChangeText={setContactSearch} /><View style={styles.actionRow}><Text style={styles.listCaption}>{contacts.length} CONTACT{contacts.length === 1 ? "" : "S"}{contactSearch ? " TROUVÉ" + (contacts.length === 1 ? "" : "S") : ""}</Text>{contactsLoading && <ActivityIndicator size="small" color={palette.accent} />}</View></View>}
        ListEmptyComponent={workspaceLoading || contactsLoading ? loading : <Empty icon="people-outline" title={contactSearch ? "Personne à ce nom." : "Les bonnes personnes,\nà portée de main."} detail={contactSearch ? "Essayez un autre nom ou un numéro." : "Ajoutez vos contacts et retrouvez-les sur tous les appareils de votre équipe."} action={contactSearch ? "Effacer la recherche" : "Ajouter un contact"} onAction={() => contactSearch ? setContactSearch("") : setContactFormVisible(true)} />}
        renderItem={({ item }) => <View style={styles.listRow}>
          <View style={styles.roundIcon}><Text style={styles.iconText}>{item.display_name.split(" ").filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</Text></View>
          <Pressable style={styles.rowCopy} accessibilityRole="button" accessibilityLabel={`Actions pour ${item.display_name}`} onPress={() => Alert.alert(item.display_name, item.contact_phones.map((phone) => phone.phone_number).join("\n") || item.email || "Aucun numéro", [{ text: "Fermer", style: "cancel" }, { text: "Archiver le contact", style: "destructive", onPress: () => Alert.alert("Archiver ce contact ?", `${item.display_name} sera retiré du carnet partagé.`, [{ text: "Annuler", style: "cancel" }, { text: "Archiver", style: "destructive", onPress: () => void archiveContact(item.id) }]) }])}><Text style={styles.rowTitle} numberOfLines={1}>{item.display_name}</Text><Text style={styles.rowMeta} numberOfLines={1}>{item.contact_phones[0]?.phone_number ?? item.email ?? "Aucun numéro"}</Text></Pressable>
          {item.contact_phones[0] && <View style={styles.actionRow}><IconButton icon="chatbubble-outline" label={`Écrire à ${item.display_name}`} onPress={() => newMessage(item.contact_phones[0]!.phone_number)} /><IconButton icon="call-outline" label={`Composer le numéro de ${item.display_name}`} tone="accent" onPress={() => openDialer(item.contact_phones[0]!.phone_number)} /></View>}
        </View>}
      />}
      {activeTab === "conversations" && <View style={[styles.flex, isThread && { display: "none" }]} accessibilityElementsHidden={isThread} importantForAccessibility={isThread ? "no-hide-descendants" : "auto"}><ConversationInbox
        inbox={inbox} loading={workspaceLoading} refreshing={refreshing} locked={smsLocked}
        hasMore={Boolean(inboxCursors.calls || inboxCursors.conversations)} loadingMore={loadingMore}
        onRefresh={() => void refreshCurrentWorkspace()} onMore={() => void loadMoreInbox()} onOpen={openConversation} onNew={() => newMessage()}
        header={<>{lineOverview}{smsRecoveryState === "checking" && <Text style={styles.hint}>Vérification des envois précédents…</Text>}{smsRecoveryState === "unavailable" && <ActionButton label="Réessayer la connexion" quiet icon="refresh" onPress={() => void retrySmsRecovery()} />}{pendingSmsAttempt && <ActionButton label="Reprendre le SMS à vérifier" quiet icon="time-outline" onPress={() => setMessageComposerVisible(true)} />}</>}
      /></View>}
      {isThread && <ConversationThread
        key={`${selectedLineId}:${recipientEditable ? "new" : phoneKey(messageDestination)}`}
        number={messageDestination} name={selectedConversationContactName ?? null} lineNumber={activeLine?.phone_number ?? ""}
        calls={selectedThread?.calls ?? []} messages={history.messages} state={history.state} hasOlder={history.hasOlder} loadingOlder={history.loadingOlder}
        hasMoreCalls={Boolean(inboxCursors.calls)} loadingMore={loadingMore} onMoreCalls={() => void loadMoreInbox()}
        onOlder={() => void history.loadOlder()} onRetry={() => void history.refresh()} refreshing={refreshing} onRefresh={() => void refreshCurrentWorkspace()}
        body={messageBody} onBody={setMessageBody} onDestination={changeMessageDestination} recipientEditable={recipientEditable}
        locked={smsLocked} pending={Boolean(pendingSmsAttempt)} recoveryReady={smsRecoveryState === "ready"} busy={busy}
        canSms={Boolean(activeLine?.sms_enabled && activeAssignment?.can_sms)} canCall={canCall}
        segments={smsSegmentInfo.segments} onSend={() => void sendMessage()} onCall={() => openDialer(messageDestination)}
        onTranscript={(callId) => setTranscriptTarget({ callId })}
        bottomInset={keyboardVisible ? 0 : insets.bottom}
        defaultPhoneCountry={defaultPhoneCountry}
      />}
      {activeTab === "settings" && <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.settingsAccount}><View style={styles.settingsAvatar}><Text style={styles.settingsInitial}>{session.user.email?.slice(0, 1).toUpperCase() ?? "O"}</Text></View><View style={styles.rowCopy}><Text style={styles.rowTitle} numberOfLines={1}>{session.user.email}</Text><Text style={styles.rowMeta}>{organizations.find((item) => item.organization_id === selectedOrg)?.organizations?.name ?? "Votre compte professionnel"}</Text></View></View>
        <View><Text style={styles.settingsLabel}>VOTRE LIGNE</Text><Card><View style={styles.actionRow}><View style={styles.lineIcon}><Icon name="phone-portrait-outline" color={palette.accent} /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>{activeLine?.phone_number ?? "Aucune ligne attribuée"}</Text><Text style={styles.rowMeta}>{activeLine ? "Ligne professionnelle" : "Demandez une ligne à votre administrateur."}</Text></View></View>
          <View style={[styles.permissionRow, { marginTop: 12 }]}><Icon name="call-outline" color={palette.muted} /><View style={styles.rowCopy}><Text style={styles.rowTitle}>Appels</Text><Text style={styles.rowMeta}>{activeLine?.voice_enabled && activeAssignment?.can_voice ? voiceStatus : "Non activés"}</Text></View></View>
          <View style={styles.permissionRow}><Icon name="chatbubbles-outline" color={palette.muted} /><View style={styles.rowCopy}><Text style={styles.rowTitle}>Messages</Text><Text style={styles.rowMeta}>{activeLine?.sms_enabled && activeAssignment?.can_sms ? "SMS activés" : "Non activés"}</Text></View></View>
          {canReceiveNativeCalls && <Text style={styles.hint}>Les appels entrants sonnent aussi lorsque l’application est en arrière-plan.</Text>}
        </Card></View>
        {selectedOrg && <TagManager key={`${session.user.id}:${selectedOrg}`} api={api} organizationId={selectedOrg} />}
        <View><Text style={styles.settingsLabel}>APPAREILS CONNECTÉS</Text><Card>{devices.length ? devices.map((device) => <View style={styles.listRow} key={device.id}><View style={styles.roundIcon}><Icon name={device.platform === "ios" || device.platform === "android" ? "phone-portrait-outline" : "laptop-outline"} color={palette.accent} /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>{device.label}</Text><Text style={styles.rowMeta}>{device.status === "active" ? "Actif" : "Révoqué"}{device.last_active_at ? ` · ${relativeCallDate(device.last_active_at)}` : ""}</Text></View>{device.status === "active" && <IconButton icon="log-out-outline" label={`Révoquer ${device.label}`} onPress={() => Alert.alert("Déconnecter cet appareil ?", `${device.label} ne recevra plus les appels.`, [{ text: "Annuler", style: "cancel" }, { text: "Déconnecter", style: "destructive", onPress: () => void revokeDevice(device.id) }])} />}</View>) : <Text style={styles.hint}>Votre appareil apparaîtra ici une fois votre ligne vocale connectée.</Text>}</Card></View>
        {organizations.length > 1 && <Card><SectionTitle title="Votre organisation" />{organizations.map((organization) => <Pill key={organization.organization_id} selected={selectedOrg === organization.organization_id} disabled={callStatus !== "idle" || smsLocked} label={organization.organizations?.name ?? "Organisation"} onPress={() => selectOrganization(organization.organization_id)} />)}</Card>}
        <ActionButton label="Se déconnecter" icon="log-out-outline" quiet onPress={() => void signOut()} disabled={busy || Boolean(pendingSmsAttempt)} />
        <Text style={[styles.rowMeta, { textAlign: "center", paddingBottom: 12 }]}>Onoff Mobile · Version {mobilePackage.version}</Text>
      </ScrollView>}
    </KeyboardAvoidingView>
    {!keyboardVisible && !isThread && <View style={[styles.nav, { paddingBottom: Math.max(insets.bottom, 10) }]}><View style={styles.navRow}>
      {tabs.slice(0, 2).map(renderTab)}
      <Touch accessibilityLabel={callStatus === "idle" ? "Ouvrir le clavier téléphonique" : "Ouvrir le clavier de l’appel"} style={styles.tab} onPress={() => openDialer()}><View style={styles.dialerButton}><Icon name="keypad-outline" size={21} color={palette.accent} /></View><Text style={styles.tabLabel}>Clavier</Text></Touch>
      {tabs.slice(2).map(renderTab)}
    </View></View>}
    {dialerVisible && <Dialer initialNumber={destination} lineNumber={activeLine?.phone_number} canCall={canCall} unavailableReason={callUnavailableReason} busy={busy} notice={notice} onClose={(number) => { setDestination(number); setDialerVisible(false); }} onCall={startCall} onContacts={(number) => { setDestination(number); setDialerVisible(false); changeTab("contacts"); }} />}
    <Sheet visible={contactFormVisible} title="Nouveau contact" closeDisabled={busy} onClose={() => setContactFormVisible(false)}>

    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.hint}>Un contact partagé avec toute votre équipe.</Text>
        <View><Text style={styles.fieldLabel}>Nom</Text><TextInput accessibilityLabel="Nom du contact" style={styles.input} placeholder="Prénom et nom" placeholderTextColor={palette.muted} value={contactName} onChangeText={setContactName} autoComplete="name" maxLength={120} />
          <Text style={styles.fieldLabel}>Téléphone</Text><TextInput accessibilityLabel="Téléphone du contact" style={styles.input} placeholder="Numéro local ou international" placeholderTextColor={palette.muted} keyboardType="phone-pad" value={contactPhone} onChangeText={setContactPhone} /><Text style={styles.hint}>Numéro local : indicatif {defaultPhoneCallingCode} ajouté automatiquement.</Text>
          {duplicateContact && <Text style={styles.duplicateWarning}>Ce numéro figure déjà chez {duplicateContact.display_name}. Vérifiez avant d’enregistrer.</Text>}
          <Text style={styles.fieldLabel}>E-mail · facultatif</Text><TextInput accessibilityLabel="E-mail du contact" style={styles.input} placeholder="Adresse e-mail" placeholderTextColor={palette.muted} keyboardType="email-address" autoCapitalize="none" value={contactEmail} onChangeText={setContactEmail} />
        </View>
        {!!notice && <Text accessibilityRole="alert" style={[styles.hint, { color: palette.red }]}>{notice}</Text>}
        <ActionButton label="Enregistrer le contact" icon="checkmark" loading={busy} onPress={() => void saveContact()} disabled={!selectedOrg || !contactName.trim()} />
        {!selectedOrg && <Text style={styles.hint}>Vous devez rejoindre une organisation pour ajouter des contacts.</Text>}
      </ScrollView></KeyboardAvoidingView>
    </Sheet>
    </>}
    {transcriptTarget && <CallTranscript key={`${session.user.id}:${selectedOrg}:${transcriptTarget.callId ?? transcriptTarget.providerCallSid}`} api={api} getAudioSource={getCallAudioSource} playbackBlocked={callStatus !== "idle"} target={transcriptTarget} onClose={() => setTranscriptTarget(null)} onHangup={callStatus === "active" || callStatus === "reconnecting" ? () => voiceRef.current?.hangUp() : undefined} />}
  </SafeAreaView>;
}
