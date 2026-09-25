import { createClient, type Session } from "@supabase/supabase-js";
import mobilePackage from "./package.json";
import { ApiClientError, createApiClient, getSmsSegmentInfo } from "@onoff/api-client";
import { createNativeVoiceClient, type NativeAudioRoute, type NativeVoiceClient } from "@onoff/voice-native";
import * as SecureStore from "expo-secure-store";
import * as Linking from "expo-linking";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const apiBase = (process.env.EXPO_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");
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

type Tab = "calls" | "contacts" | "messages" | "settings";
type Organization = { organization_id: string; role: "admin" | "member"; organizations: { id: string; name: string } | null };
type LineAssignment = { can_voice: boolean; can_sms: boolean; status?: string; lines: { id: string; organization_id: string; phone_number: string; voice_enabled: boolean; sms_enabled: boolean } | null };
type Contact = { id: string; display_name: string; email: string | null; version: number; contact_phones: { id: string; phone_number: string; label: string }[] };
type CallRecord = { id: string; direction: "inbound" | "outbound"; remote_number: string; remoteContactName: string | null; status: string; created_at: string; duration_seconds: number | null };
type Message = { id: string; direction: "inbound" | "outbound"; body: string; status: string; provider_error_code: string | null; created_at: string; sent_at: string | null; delivered_at: string | null };
type Conversation = { id: string; lineId: string; remoteNumber: string; remoteContactName: string | null; lastMessageAt: string | null; lastMessage: { id: string; body: string; direction: string; status: string; created_at: string } | null; unread: boolean };
type DeviceRecord = { id: string; organization_id: string; platform: string; label: string; status: string; last_active_at: string | null; created_at: string };
type VoiceDiagnosticEvent = "voice_registration_failed" | "history_refresh_succeeded" | "history_refresh_failed";
const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: "calls", label: "Appels", icon: "⌕" },
  { id: "contacts", label: "Contacts", icon: "♙" },
  { id: "messages", label: "Messages", icon: "▤" },
  { id: "settings", label: "Réglages", icon: "⚙" },
];
const voiceRegistrationRefreshMs = 50 * 60 * 1000;

function actionKey(): string {
  const bytes = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  return bytes.join("");
}

function normalizePhone(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("+")) return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.startsWith("0")) return `+32${digits.slice(1)}`;
  return digits ? `+32${digits}` : "";
}

function friendlyError(error: unknown): string {
  return error instanceof Error ? error.message : "Une erreur inattendue est survenue.";
}

export default function App() {
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
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageDestination, setMessageDestination] = useState("");
  const [messageBody, setMessageBody] = useState("");
  const [pendingSmsAttempt, setPendingSmsAttempt] = useState<{ signature: string; key: string } | null>(null);
  const [smsRecoveryState, setSmsRecoveryState] = useState<"checking" | "ready" | "unavailable">("checking");
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("calls");
  const [destination, setDestination] = useState("");
  const [voiceStatus, setVoiceStatus] = useState("Ligne inactive");
  const [callStatus, setCallStatus] = useState<"idle" | "connecting" | "ringing" | "active" | "reconnecting">("idle");
  const [incomingNumber, setIncomingNumber] = useState("");
  const [muted, setMuted] = useState(false);
  const [canReceiveNativeCalls, setCanReceiveNativeCalls] = useState(false);
  const [audioDevices, setAudioDevices] = useState<NativeAudioRoute[]>([]);
  const [selectedAudioDevice, setSelectedAudioDevice] = useState("");
  const [keypadVisible, setKeypadVisible] = useState(false);
  const voiceRef = useRef<NativeVoiceClient | null>(null);
  const activeTabRef = useRef(activeTab);
  const selectedConversationIdRef = useRef(selectedConversationId);
  activeTabRef.current = activeTab;
  selectedConversationIdRef.current = selectedConversationId;
  const smsSegmentInfo = getSmsSegmentInfo(messageBody.trim());
  const selectedConversationContactName = conversations.find((conversation) => conversation.id === selectedConversationId)?.remoteContactName ?? null;
  const duplicateContact = normalizePhone(contactPhone)
    ? contacts.find((contact) => contact.contact_phones.some((phone) => phone.phone_number === normalizePhone(contactPhone)))
    : undefined;
  const deviceRef = useRef<DeviceRecord | null>(null);
  const voiceTokenRef = useRef("");
  const voiceRegistrationRef = useRef(false);
  const registeredUserRef = useRef("");

  const authToken = session?.access_token;
  const apiClient = useMemo(() => createApiClient({ baseUrl: apiBase, getAccessToken: () => authToken }), [authToken]);
  const activeAssignment = useMemo(
    () => lines.find((item) => item.lines?.id === selectedLineId) ?? lines.find((item) => item.lines) ?? null,
    [lines, selectedLineId],
  );
  const activeLine = activeAssignment?.lines ?? null;
  const api = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    if (!apiBase) throw new Error("Configurez EXPO_PUBLIC_API_BASE_URL dans apps/mobile/.env.");
    return apiClient.request<T>(path, init);
  }, [apiClient]);
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
    const [lineResponse, contactResponse, deviceResponse] = await Promise.all([
      api<{ items: LineAssignment[] }>(`/v1/organizations/${orgId}/lines`),
      api<{ items: Contact[] }>(`/v1/organizations/${orgId}/contacts?limit=50${contactSearch ? `&q=${encodeURIComponent(contactSearch)}` : ""}`),
      api<{ items: DeviceRecord[] }>("/v1/devices"),
    ]);
    setLines(lineResponse.items);
    setContacts(contactResponse.items);
    setDevices(deviceResponse.items);
    const target = lineResponse.items.find((item) => item.lines?.id === (preferredLineId ?? selectedLineId))
      ?? lineResponse.items.find((item) => item.lines);
    const targetLineId = target?.lines?.id ?? "";
    setSelectedLineId(targetLineId);
    if (!targetLineId) {
      setCalls([]);
      setConversations([]);
      setSelectedConversationId("");
      return;
    }
    const [callResponse, conversationResponse] = await Promise.all([
      api<{ items: CallRecord[] }>(`/v1/lines/${targetLineId}/calls?limit=50`),
      api<{ items: Conversation[] }>(`/v1/lines/${targetLineId}/conversations?limit=50`),
    ]);
    setCalls(callResponse.items);
    setConversations(conversationResponse.items);
    setSelectedConversationId((current) => conversationResponse.items.some((item) => item.id === current)
      ? current
      : conversationResponse.items[0]?.id ?? "");
  }, [api, contactSearch, selectedLineId]);

  async function restorePendingSmsAttempt(isCurrent: () => boolean = () => true): Promise<void> {
    const { items } = await api<{ items: Array<{ message_id: string; organization_id: string; conversation_id: string; line_id: string; destination: string; body: string; idempotency_key: string }> }>("/v1/messages/pending");
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
    setActiveTab("messages");
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
        setOrganizations([]);
        setLines([]);
        setContacts([]);
        setCalls([]);
        setConversations([]);
        setMessages([]);
        setDevices([]);
        setSelectedOrg("");
        setSelectedLineId("");
        setSelectedConversationId("");
        setPendingSmsAttempt(null);
        setSmsRecoveryState("checking");
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
    const voice = createNativeVoiceClient(Platform.OS === "ios" ? "ios" : "android");
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
          setCallStatus("ringing");
          break;
        case "connecting": setCallStatus("connecting"); break;
        case "ringing": setCallStatus("ringing"); break;
        case "active":
        case "reconnected":
          setIncomingNumber("");
          setCallStatus("active");
          break;
        case "reconnecting": setCallStatus("reconnecting"); break;
        case "ended":
          setIncomingNumber("");
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
    setSmsRecoveryState("checking");
    void (async () => {
      const { items } = await api<{ items: Organization[] }>("/v1/organizations");
      if (cancelled) return;
      setOrganizations(items);
      const next = selectedOrg && items.some((item) => item.organization_id === selectedOrg)
        ? selectedOrg
        : items[0]?.organization_id ?? "";
      setSelectedOrg(next);
      if (next) await refreshWorkspace(next);
      await restorePendingSmsAttempt(() => !cancelled);
      if (!cancelled) setSmsRecoveryState("ready");
    })().catch(() => {
      if (cancelled) return;
      setSmsRecoveryState("unavailable");
      setNotice("Les SMS à vérifier ne sont pas disponibles. Vérifiez la connexion puis réessayez.");
    });
    return () => { cancelled = true; };
  // Load organizations whenever the authenticated identity changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  useEffect(() => {
    if (!authToken || !selectedOrg) return;
    void refreshWorkspace(selectedOrg).catch((error: unknown) => setNotice(friendlyError(error)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken, selectedOrg]);

  useEffect(() => {
    if (!authToken || !selectedLineId || !selectedConversationId || activeTab !== "messages") {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void api<{ items: Message[] }>(`/v1/conversations/${selectedConversationId}/messages?limit=50`)
      .then(({ items }) => {
        if (cancelled) return;
        setMessages(items);
        const last = items[items.length - 1];
        if (last) void api(`/v1/conversations/${selectedConversationId}/read`, { method: "PUT", body: JSON.stringify({ lastReadMessageId: last.id }) })
          .then(() => { if (!cancelled) setConversations((current) => current.map((conversation) => conversation.id === selectedConversationId ? { ...conversation, unread: false } : conversation)); })
          .catch(() => undefined);
      })
      .catch((error: unknown) => { if (!cancelled) setNotice(friendlyError(error)); });
    return () => { cancelled = true; };
  }, [activeTab, api, authToken, selectedConversationId, selectedLineId]);

  useEffect(() => {
    if (!authToken || !selectedOrg || !selectedLineId || !supabase) return;
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (cancelled || refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refreshWorkspace(selectedOrg, selectedLineId).catch((error: unknown) => setNotice(friendlyError(error)));
      }, 150);
    };
    const refreshFromEvent = (payload: unknown) => {
      if (cancelled || !payload || typeof payload !== "object") return;
      const kind = (payload as { kind?: unknown }).kind;
      const reportError = (error: unknown) => { if (!cancelled) setNotice(friendlyError(error)); };
      if (kind === "contact") {
        void api<{ items: Contact[] }>(`/v1/organizations/${selectedOrg}/contacts?limit=50${contactSearch ? `&q=${encodeURIComponent(contactSearch)}` : ""}`)
          .then(({ items }) => { if (!cancelled) setContacts(items); }).catch(reportError);
      } else if (kind === "device") {
        void api<{ items: DeviceRecord[] }>("/v1/devices")
          .then(({ items }) => { if (!cancelled) setDevices(items); }).catch(reportError);
      } else if (kind === "call") {
        void api<{ items: CallRecord[] }>(`/v1/lines/${selectedLineId}/calls?limit=50`)
          .then(({ items }) => { if (!cancelled) setCalls(items); }).catch(reportError);
      } else if (kind === "message") {
        void api<{ items: Conversation[] }>(`/v1/lines/${selectedLineId}/conversations?limit=50`)
          .then(({ items }) => { if (!cancelled) setConversations(items); }).catch(reportError);
        const conversationId = selectedConversationIdRef.current;
        if (conversationId) {
          void api<{ items: Message[] }>(`/v1/conversations/${conversationId}/messages?limit=50`)
            .then(async ({ items }) => {
              if (cancelled) return;
              setMessages(items);
              if (activeTabRef.current === "messages") {
                const last = items.at(-1);
                if (last) {
                  await api(`/v1/conversations/${conversationId}/read`, { method: "PUT", body: JSON.stringify({ lastReadMessageId: last.id }) });
                  if (!cancelled) setConversations((current) => current.map((conversation) => conversation.id === conversationId ? { ...conversation, unread: false } : conversation));
                }
              }
            }).catch(reportError);
        }
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
        if (status === "SUBSCRIBED" && subscribedBefore) refresh();
        if (status === "SUBSCRIBED") subscribedBefore = true;
      });
    }
    const appState = AppState.addEventListener("change", (state) => { if (state === "active") refresh(); });
    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      appState.remove();
      for (const channel of channels) void supabase.removeChannel(channel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken, selectedOrg, selectedLineId, contactSearch, selectedConversationId]);

  useEffect(() => {
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
      setCanReceiveNativeCalls(token.incomingEnabled);
      if (token.incomingEnabled && !voiceRegistrationRef.current) {
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
      setVoiceStatus(token.incomingEnabled ? "Appareil prêt pour les appels" : "Appels sortants prêts; le push entrant reste à configurer");
    })().catch((error: unknown) => {
      if (!cancelled) setVoiceStatus(friendlyError(error));
    });
    return () => { cancelled = true; };
  }, [activeAssignment?.can_voice, activeLine?.id, activeLine?.organization_id, activeLine?.voice_enabled, api, authToken, markVoiceState, selectedOrg, session?.user.id]);

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

  async function startCall() {
    const normalized = normalizePhone(destination);
    if (!activeLine || !activeAssignment?.can_voice || !deviceRef.current || !normalized) {
      setNotice("Choisissez une ligne vocale et un numéro au format international.");
      return;
    }
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
    const phone = normalizePhone(contactPhone);
    if (!selectedOrg || !contactName.trim()) return;
    if (contactPhone && !/^\+[1-9]\d{7,14}$/.test(phone)) {
      setNotice("Le numéro doit être au format international, par exemple +32470000000.");
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
    const normalized = normalizePhone(messageDestination || (conversations.find((item) => item.id === selectedConversationId)?.remoteNumber ?? ""));
    if (!normalized || !messageBody.trim()) {
      setNotice("Saisissez un numéro international et un message.");
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
      const refreshed = await api<{ items: Message[] }>(`/v1/conversations/${result.conversationId}/messages?limit=50`);
      setMessages(refreshed.items);
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
    setCalls([]);
    setConversations([]);
    setSelectedConversationId("");
    setMessages([]);
    setDevices([]);
    setDestination("");
    setMessageDestination("");
    setMessageBody("");
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
    setCalls([]);
    setConversations([]);
    setSelectedConversationId("");
    setMessages([]);
    setSelectedLineId(lineId);
  }

  if (!authReady) return <View style={styles.center}><ActivityIndicator color={palette.accent} /><Text style={styles.muted}>Ouverture de votre espace…</Text></View>;
  if (!session || recoveringPassword) {
    return (
      <KeyboardAvoidingView style={styles.authScreen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.authCard}>
          <View style={styles.brandMark}><Text style={styles.brandLetter}>o</Text></View>
          <Text style={styles.eyebrow}>ONOFF BUSINESS</Text>
          <Text style={styles.title}>{recoveringPassword ? "Nouveau mot de passe" : "Bienvenue"}</Text>
          <Text style={styles.body}>{recoveringPassword ? "Choisissez un mot de passe pour votre compte." : "Connectez-vous à votre espace téléphonique."}</Text>
          {!recoveringPassword && <><TextInput style={styles.input} placeholder="Adresse e-mail" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} /><TextInput style={styles.input} placeholder="Mot de passe" secureTextEntry value={password} onChangeText={setPassword} /></>}
          {recoveringPassword && <TextInput style={styles.input} placeholder="Nouveau mot de passe" secureTextEntry value={newPassword} onChangeText={setNewPassword} />}
          {!!authError && <Text accessibilityRole="alert" style={styles.noticeText}>{authError}</Text>}
          <ActionButton label={recoveringPassword ? "Mettre à jour" : "Se connecter"} onPress={() => void (recoveringPassword ? updatePassword() : signIn())} disabled={busy} />
          {!recoveringPassword && <ActionButton label="Mot de passe oublié ?" quiet onPress={() => void requestPasswordRecovery()} />}
          {recoveringPassword && <ActionButton label="Retour à la connexion" quiet onPress={() => setRecoveringPassword(false)} />}
          {!supabase && <Text style={styles.noticeText}>Configurez les variables publiques dans apps/mobile/.env.</Text>}
        </View>
      </KeyboardAvoidingView>
    );
  }

  const tabTitle = tabs.find((tab) => tab.id === activeTab)?.label ?? "Onoff";
  return (
    <View style={styles.app}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <View><Text style={styles.eyebrow}>ONOFF BUSINESS</Text><Text style={styles.headerTitle}>{tabTitle}</Text></View>
        <View style={styles.avatar}><Text style={styles.avatarText}>{session.user.email?.slice(0, 1).toUpperCase() ?? "O"}</Text></View>
      </View>
      <View style={styles.selectors}>
        {organizations.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pills}>{organizations.filter((item) => item.organizations).map((item) => <Pill key={item.organization_id} selected={selectedOrg === item.organization_id} disabled={callStatus !== "idle" || Boolean(pendingSmsAttempt) || smsRecoveryState !== "ready"} label={item.organizations?.name ?? "Organisation"} onPress={() => selectOrganization(item.organization_id)} />)}</ScrollView>}
        {!!activeLine && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pills}>{lines.filter((item) => item.lines).map((item) => <Pill key={item.lines?.id} selected={selectedLineId === item.lines?.id} disabled={callStatus !== "idle" || Boolean(pendingSmsAttempt) || smsRecoveryState !== "ready"} label={item.lines?.phone_number ?? "Ligne"} onPress={() => selectLine(item.lines?.id ?? "")} />)}</ScrollView>}
      </View>
      {!!notice && <Pressable onPress={() => setNotice("")} style={styles.notice}><Text style={styles.noticeText}>{notice}</Text><Text style={styles.noticeClose}>×</Text></Pressable>}
      {callStatus !== "idle" && <View style={styles.callBanner}>
        <View>
          <Text style={styles.callBannerTitle}>{incomingNumber ? `Appel de ${incomingNumber}` : callStatus === "active" ? "Appel en cours" : callStatus === "reconnecting" ? "Reconnexion" : callStatus === "connecting" ? "Connexion en cours" : "Appel en cours de connexion"}</Text>
          <Text style={styles.callBannerMeta}>{voiceStatus}{selectedAudioDevice ? ` · ${audioDevices.find((device) => device.id === selectedAudioDevice)?.name ?? "Audio"}` : ""}</Text>
        </View>
        <View style={styles.actionRow}>
          {incomingNumber
            ? <><SmallButton label="Répondre" onPress={() => voiceRef.current?.acceptCall()} /><SmallButton label="Refuser" quiet onPress={() => voiceRef.current?.rejectCall()} /></>
            : <>
              <SmallButton label={muted ? "Son" : "Muet"} quiet onPress={() => voiceRef.current?.setMuted(!muted)} />
              <SmallButton label="Clavier" quiet onPress={() => setKeypadVisible((shown) => !shown)} />
              <SmallButton label="Audio" quiet onPress={() => void changeAudioRoute()} />
              <SmallButton label="Raccrocher" danger onPress={() => voiceRef.current?.hangUp()} />
            </>}
        </View>
        {keypadVisible && !incomingNumber && <View style={styles.keypad}>{["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((digit) => <Pressable key={digit} accessibilityRole="button" accessibilityLabel={`Tonalité ${digit}`} style={styles.keypadKey} onPress={() => voiceRef.current?.sendDigits(digit)}><Text style={styles.keypadDigit}>{digit}</Text></Pressable>)}</View>}
      </View>}
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {activeTab === "calls" && <>
          <Card>
            <SectionTitle eyebrow="NOUVEL APPEL" title="Composer" />
            <TextInput style={styles.input} accessibilityLabel="Numéro à appeler" keyboardType="phone-pad" value={destination} onChangeText={setDestination} placeholder="+32 470 00 00 00" />
            <ActionButton label={busy ? "Préparation…" : "Appeler"} onPress={() => void startCall()} disabled={busy || !activeAssignment?.can_voice || !activeLine?.voice_enabled || callStatus !== "idle"} />
            <Text style={styles.hint}>{activeLine?.voice_enabled && activeAssignment?.can_voice ? voiceStatus : "Les appels sont désactivés pour cette ligne."}</Text>
            {canReceiveNativeCalls && <Text style={styles.hint}>Les appels entrants arrivent via l’interface native de l’appareil.</Text>}
          </Card>
          <Card><SectionTitle eyebrow="ACTIVITÉ" title="Appels récents" />{calls.length ? calls.map((call) => <View style={styles.listRow} key={call.id}><View style={[styles.roundIcon, call.direction === "outbound" ? styles.purple : styles.green]}><Text style={styles.iconText}>{call.direction === "outbound" ? "↗" : "↙"}</Text></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>{call.remoteContactName ?? call.remote_number}</Text><Text style={styles.rowMeta}>{call.remoteContactName ? `${call.remote_number} · ` : ""}{call.direction === "outbound" ? "Sortant" : "Entrant"} · {new Date(call.created_at).toLocaleString("fr-BE", { dateStyle: "short", timeStyle: "short" })}</Text></View><Text style={styles.status}>{call.status}</Text></View>) : <Empty title="Aucun appel pour le moment" detail="L’historique de votre ligne apparaîtra ici." />}</Card>
        </>}
        {activeTab === "contacts" && <>
          <Card><SectionTitle eyebrow="CARNET PARTAGÉ" title="Nouveau contact" /><TextInput style={styles.input} placeholder="Nom du contact" value={contactName} onChangeText={setContactName} maxLength={120} /><TextInput style={styles.input} placeholder="Téléphone international" keyboardType="phone-pad" value={contactPhone} onChangeText={setContactPhone} />{duplicateContact && <Text style={styles.duplicateWarning} accessibilityRole="text">Ce numéro figure déjà chez {duplicateContact.display_name}. Vérifiez avant d’enregistrer; les contacts ne seront pas fusionnés.</Text>}<TextInput style={styles.input} placeholder="E-mail (facultatif)" keyboardType="email-address" autoCapitalize="none" value={contactEmail} onChangeText={setContactEmail} /><ActionButton label={busy ? "Enregistrement…" : "Ajouter au carnet"} onPress={() => void saveContact()} disabled={busy || !contactName.trim()} /></Card>
          <Card><SectionTitle eyebrow={`${contacts.length} CONTACT${contacts.length === 1 ? "" : "S"}`} title="Répertoire" /><TextInput style={styles.input} placeholder="Rechercher" value={contactSearch} onChangeText={setContactSearch} /><View style={styles.actionRow}><Text style={styles.hint}>Actions rapides</Text></View>{contacts.filter((item) => item.display_name.toLowerCase().includes(contactSearch.toLowerCase())).map((contact) => <View style={styles.listRow} key={contact.id}><View style={[styles.roundIcon, styles.green]}><Text style={styles.iconText}>{contact.display_name.slice(0, 1).toUpperCase()}</Text></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>{contact.display_name}</Text><Text style={styles.rowMeta}>{contact.contact_phones[0]?.phone_number ?? contact.email ?? "Aucun numéro"}</Text><View style={[styles.actionRow, { marginTop: 8 }]}>{contact.contact_phones[0]?.phone_number && <><SmallButton label="Appeler" quiet onPress={() => { setDestination(contact.contact_phones[0]!.phone_number); setActiveTab("calls"); }} /><SmallButton label="SMS" quiet onPress={() => { setMessageDestination(contact.contact_phones[0]!.phone_number); setActiveTab("messages"); }} /></>}</View></View><Pressable onPress={() => void archiveContact(contact.id)} accessibilityLabel={`Archiver ${contact.display_name}`}><Text style={styles.archive}>⌫</Text></Pressable></View>)}{!contacts.length && <Empty title="Votre carnet est prêt" detail="Ajoutez un contact pour le partager avec l’équipe." />}</Card>
        </>}
        {activeTab === "messages" && <>
          {smsRecoveryState === "checking" && <Text style={styles.hint}>Vérification des SMS en cours…</Text>}
          {smsRecoveryState === "unavailable" && <ActionButton label="Réessayer la vérification des SMS" quiet onPress={() => void retrySmsRecovery()} />}
          <Card><SectionTitle eyebrow="MESSAGERIE" title="Conversations" />{conversations.length ? conversations.map((conversation) => <Pressable key={conversation.id} disabled={Boolean(pendingSmsAttempt) || smsRecoveryState !== "ready"} style={[styles.listRow, selectedConversationId === conversation.id && styles.selectedRow]} accessibilityLabel={`${conversation.remoteContactName ?? conversation.remoteNumber}${conversation.unread ? ", non lu" : ""}`} onPress={() => { setSelectedConversationId(conversation.id); setMessageDestination(conversation.remoteNumber); }}><View style={[styles.roundIcon, styles.purple]}><Text style={styles.iconText}>▤</Text></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>{conversation.remoteContactName ?? conversation.remoteNumber}</Text><Text style={styles.rowMeta} numberOfLines={1}>{conversation.remoteContactName ? `${conversation.remoteNumber} · ` : ""}{conversation.lastMessage?.body ?? "Aucun message"}</Text></View><View style={{ alignItems: "flex-end" }}>{conversation.unread && <Text style={styles.unread}>Non lu</Text>}<Text style={styles.rowMeta}>{conversation.lastMessageAt ? new Date(conversation.lastMessageAt).toLocaleDateString("fr-BE") : ""}</Text></View></Pressable>) : <Empty title="Aucune conversation" detail="Les SMS compatibles apparaîtront ici." />}</Card>
          {!!selectedConversationId && <Card><SectionTitle eyebrow="CONVERSATION" title={selectedConversationContactName ?? (messageDestination || conversations.find((item) => item.id === selectedConversationId)?.remoteNumber || "Messages")} />{selectedConversationContactName && <Text style={styles.rowMeta}>{messageDestination}</Text>}{messages.map((message) => <View key={message.id} style={[styles.messageBubble, message.direction === "outbound" && styles.outgoingBubble]}><Text style={styles.messageText}>{message.body}</Text><Text style={styles.messageMeta}>{message.status} · {new Date(message.created_at).toLocaleTimeString("fr-BE", { hour: "2-digit", minute: "2-digit" })}</Text></View>)}<TextInput style={styles.input} editable={!pendingSmsAttempt && smsRecoveryState === "ready"} placeholder="Numéro international" keyboardType="phone-pad" value={messageDestination} onChangeText={setMessageDestination} /><TextInput style={[styles.input, styles.multiline]} editable={!pendingSmsAttempt && smsRecoveryState === "ready"} placeholder="Écrire un message" value={messageBody} onChangeText={setMessageBody} multiline maxLength={1600} /><Text style={styles.hint}>{smsSegmentInfo.encoding} · {smsSegmentInfo.characterCount} unités · {smsSegmentInfo.segments} segment{smsSegmentInfo.segments === 1 ? "" : "s"} estimé{smsSegmentInfo.segments === 1 ? "" : "s"}</Text><ActionButton label={busy ? "Vérification…" : pendingSmsAttempt ? "Vérifier l’envoi" : smsRecoveryState !== "ready" ? "Vérification…" : "Envoyer"} onPress={() => void sendMessage()} disabled={busy || smsRecoveryState !== "ready" || !messageBody.trim() || !activeAssignment?.can_sms || !activeLine?.sms_enabled} /></Card>}
          {!selectedConversationId && <Card><SectionTitle eyebrow="NOUVEAU SMS" title="Écrire un message" />{pendingSmsAttempt && <Text style={styles.hint}>Résultat incertain : vérifiez l’envoi avec la même demande.</Text>}<TextInput style={styles.input} editable={!pendingSmsAttempt && smsRecoveryState === "ready"} placeholder="Numéro international" keyboardType="phone-pad" value={messageDestination} onChangeText={setMessageDestination} /><TextInput style={[styles.input, styles.multiline]} editable={!pendingSmsAttempt && smsRecoveryState === "ready"} placeholder="Votre message" value={messageBody} onChangeText={setMessageBody} multiline maxLength={1600} /><Text style={styles.hint}>{smsSegmentInfo.encoding} · {smsSegmentInfo.characterCount} unités · {smsSegmentInfo.segments} segment{smsSegmentInfo.segments === 1 ? "" : "s"} estimé{smsSegmentInfo.segments === 1 ? "" : "s"}</Text><ActionButton label={busy ? "Vérification…" : pendingSmsAttempt ? "Vérifier l’envoi" : smsRecoveryState !== "ready" ? "Vérification…" : "Envoyer"} onPress={() => void sendMessage()} disabled={busy || smsRecoveryState !== "ready" || !messageBody.trim() || !activeAssignment?.can_sms || !activeLine?.sms_enabled} /></Card>}
          {!activeLine?.sms_enabled && <Text style={styles.hint}>L’envoi et la réception SMS sont désactivés sur cette ligne.</Text>}
        </>}
        {activeTab === "settings" && <>
          <Card><SectionTitle eyebrow="COMPTE" title="Votre espace" /><Text style={styles.rowTitle}>{session.user.email}</Text><Text style={styles.rowMeta}>Les comptes sont créés par invitation de l’administrateur.</Text>{organizations.map((organization) => <Pill key={organization.organization_id} selected={selectedOrg === organization.organization_id} disabled={Boolean(pendingSmsAttempt) || smsRecoveryState !== "ready"} label={organization.organizations?.name ?? "Organisation"} onPress={() => selectOrganization(organization.organization_id)} />)}<ActionButton label="Se déconnecter" quiet onPress={() => void signOut()} disabled={busy || Boolean(pendingSmsAttempt)} /></Card>
          <Card><SectionTitle eyebrow="APPAREILS" title="Vos appareils" />{devices.length ? devices.map((device) => <View style={styles.listRow} key={device.id}><View style={[styles.roundIcon, device.status === "active" ? styles.green : styles.gray]}><Text style={styles.iconText}>⌘</Text></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>{device.label}</Text><Text style={styles.rowMeta}>{device.platform} · {device.status}{device.last_active_at ? ` · vu ${new Date(device.last_active_at).toLocaleDateString("fr-BE")}` : ""}</Text></View>{device.status === "active" && <Pressable onPress={() => void revokeDevice(device.id)}><Text style={styles.revoke}>Révoquer</Text></Pressable>}</View>) : <Empty title="Aucun appareil enregistré" detail="L’appareil sera ajouté à votre connexion vocale." />}</Card>
          <Card><SectionTitle eyebrow="DIAGNOSTIC" title="Version de l’application" /><Text style={styles.rowMeta}>Onoff Mobile {mobilePackage.version}</Text></Card>
        </>}
      </ScrollView>
      <View style={styles.tabBar}>{tabs.map((tab) => <Pressable key={tab.id} style={styles.tab} onPress={() => setActiveTab(tab.id)}><Text style={[styles.tabIcon, activeTab === tab.id && styles.tabActive]}>{tab.icon}</Text><Text style={[styles.tabLabel, activeTab === tab.id && styles.tabActive]}>{tab.label}</Text></Pressable>)}</View>
    </View>
  );
}

function Card({ children }: { children: React.ReactNode }) { return <View style={styles.card}>{children}</View>; }
function SectionTitle({ eyebrow, title }: { eyebrow: string; title: string }) { return <View style={styles.sectionTitle}><Text style={styles.eyebrow}>{eyebrow}</Text><Text style={styles.sectionHeading}>{title}</Text></View>; }
function Empty({ title, detail }: { title: string; detail: string }) { return <View style={styles.empty}><Text style={styles.rowTitle}>{title}</Text><Text style={styles.rowMeta}>{detail}</Text></View>; }
function Pill({ label, selected, disabled = false, onPress }: { label: string; selected: boolean; disabled?: boolean; onPress: () => void }) { return <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled }} onPress={onPress} disabled={disabled} style={[styles.pill, selected && styles.pillSelected, disabled && styles.buttonDisabled]}><Text numberOfLines={1} style={[styles.pillText, selected && styles.pillTextSelected]}>{label}</Text></Pressable>; }
function ActionButton({ label, onPress, disabled = false, quiet = false }: { label: string; onPress: () => void; disabled?: boolean; quiet?: boolean }) { return <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled} style={[styles.button, quiet && styles.buttonQuiet, disabled && styles.buttonDisabled]}><Text style={[styles.buttonLabel, quiet && styles.buttonLabelQuiet]}>{label}</Text></Pressable>; }
function SmallButton({ label, onPress, quiet = false, danger = false }: { label: string; onPress: () => void; quiet?: boolean; danger?: boolean }) { return <Pressable accessibilityRole="button" onPress={onPress} style={[styles.smallButton, quiet && styles.buttonQuiet, danger && styles.buttonDanger]}><Text style={[styles.smallButtonText, quiet && styles.buttonLabelQuiet, danger && styles.buttonLabel]}>{label}</Text></Pressable>; }

const palette = { ink: "#14212a", muted: "#75818a", accent: "#116b60", canvas: "#f4f7f5", line: "#e4e9e6", white: "#ffffff", lavender: "#f0efff", green: "#e3f4eb", red: "#fff0ef" };
const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: palette.canvas },
  authScreen: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: palette.canvas },
  authCard: { backgroundColor: palette.white, borderRadius: 26, padding: 24, borderWidth: 1, borderColor: palette.line },
  brandMark: { height: 48, width: 48, borderRadius: 16, backgroundColor: palette.accent, alignItems: "center", justifyContent: "center", marginBottom: 24 },
  brandLetter: { color: "white", fontSize: 30, fontWeight: "800" },
  header: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 12, backgroundColor: palette.white, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerTitle: { color: palette.ink, fontSize: 24, fontWeight: "800", marginTop: 2 },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: palette.lavender, alignItems: "center", justifyContent: "center" },
  avatarText: { color: palette.accent, fontWeight: "800", fontSize: 16 },
  selectors: { backgroundColor: palette.white, paddingBottom: 10 },
  pills: { paddingHorizontal: 16, gap: 8, paddingVertical: 6 },
  pill: { borderRadius: 99, borderWidth: 1, borderColor: palette.line, paddingVertical: 8, paddingHorizontal: 13, maxWidth: 210 },
  pillSelected: { borderColor: palette.accent, backgroundColor: "#e8f4f0" },
  pillText: { color: palette.muted, fontSize: 12, fontWeight: "700" },
  pillTextSelected: { color: palette.accent },
  content: { padding: 16, gap: 14, paddingBottom: 28 },
  card: { backgroundColor: palette.white, borderRadius: 20, padding: 17, borderWidth: 1, borderColor: palette.line },
  sectionTitle: { marginBottom: 12 },
  sectionHeading: { color: palette.ink, fontSize: 20, fontWeight: "800", marginTop: 3 },
  eyebrow: { color: palette.accent, fontSize: 10, fontWeight: "800", letterSpacing: 1.4 },
  title: { color: palette.ink, fontSize: 29, fontWeight: "800", marginTop: 5 },
  body: { color: palette.muted, fontSize: 14, lineHeight: 20, marginTop: 6, marginBottom: 20 },
  input: { backgroundColor: "#f8faf9", color: palette.ink, borderWidth: 1, borderColor: palette.line, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 12, fontSize: 15, marginBottom: 10 },
  multiline: { minHeight: 86, textAlignVertical: "top" },
  button: { backgroundColor: palette.accent, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, alignItems: "center", justifyContent: "center", minHeight: 45, marginTop: 3 },
  buttonQuiet: { backgroundColor: "#edf3f0", marginTop: 9 },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { color: palette.white, fontSize: 14, fontWeight: "800" },
  buttonLabelQuiet: { color: palette.accent },
  smallButton: { backgroundColor: palette.accent, paddingHorizontal: 11, paddingVertical: 8, borderRadius: 10 },
  smallButtonText: { color: palette.white, fontSize: 12, fontWeight: "700" },
  buttonDanger: { backgroundColor: "#b54142" },
  hint: { color: palette.muted, fontSize: 12, lineHeight: 17, marginTop: 9 },
  muted: { color: palette.muted, fontSize: 14, marginTop: 12 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: palette.canvas },
  listRow: { flexDirection: "row", alignItems: "center", gap: 11, paddingVertical: 11, borderTopWidth: 1, borderTopColor: "#f0f2f1" },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitle: { color: palette.ink, fontWeight: "700", fontSize: 14 },
  rowMeta: { color: palette.muted, fontSize: 11, lineHeight: 16, marginTop: 3 },
  unread: { color: palette.accent, fontSize: 10, fontWeight: "800", backgroundColor: "#e8f4f0", paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8, overflow: "hidden" },
  duplicateWarning: { color: "#8b5c22", backgroundColor: "#fff4df", borderRadius: 10, padding: 10, fontSize: 12, lineHeight: 17, marginBottom: 10 },
  roundIcon: { height: 38, width: 38, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  purple: { backgroundColor: palette.lavender },
  green: { backgroundColor: palette.green },
  gray: { backgroundColor: "#edf0ef" },
  iconText: { color: palette.accent, fontSize: 15, fontWeight: "800" },
  status: { color: palette.muted, fontSize: 10, textTransform: "capitalize" },
  empty: { paddingVertical: 18, alignItems: "center", gap: 5 },
  actionRow: { flexDirection: "row", gap: 7, alignItems: "center" },
  selectedRow: { backgroundColor: "#f0f7f4", marginHorizontal: -5, paddingHorizontal: 5, borderRadius: 12 },
  messageBubble: { alignSelf: "flex-start", maxWidth: "88%", backgroundColor: "#f0f3f2", borderRadius: 14, padding: 11, marginBottom: 8 },
  outgoingBubble: { alignSelf: "flex-end", backgroundColor: "#e7f4ef" },
  messageText: { color: palette.ink, fontSize: 14, lineHeight: 20 },
  messageMeta: { color: palette.muted, fontSize: 10, marginTop: 6, textAlign: "right" },
  archive: { color: "#a34a4d", fontSize: 19, padding: 6 },
  revoke: { color: "#a34a4d", fontSize: 11, fontWeight: "700" },
  notice: { marginHorizontal: 14, marginTop: 10, backgroundColor: palette.red, borderRadius: 12, padding: 11, flexDirection: "row", gap: 8 },
  noticeText: { color: "#8e3338", fontSize: 12, lineHeight: 17, flex: 1 },
  noticeClose: { color: "#8e3338", fontSize: 19, paddingHorizontal: 3 },
  callBanner: { marginHorizontal: 14, marginTop: 10, backgroundColor: palette.accent, borderRadius: 15, padding: 13, gap: 11 },
  callBannerTitle: { color: "white", fontWeight: "800", fontSize: 14 },
  callBannerMeta: { color: "#d1e9e1", fontSize: 11, marginTop: 2 },
  keypad: { alignSelf: "center", width: 216, flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8 },
  keypadKey: { width: 64, height: 48, borderRadius: 12, backgroundColor: "#ffffff24", alignItems: "center", justifyContent: "center" },
  keypadDigit: { color: palette.white, fontSize: 18, fontWeight: "700" },
  tabBar: { flexDirection: "row", backgroundColor: palette.white, borderTopWidth: 1, borderTopColor: palette.line, paddingTop: 9, paddingBottom: Platform.OS === "ios" ? 22 : 10 },
  tab: { flex: 1, alignItems: "center", gap: 3, paddingVertical: 3 },
  tabIcon: { color: "#83908c", fontSize: 17, fontWeight: "700" },
  tabLabel: { color: "#83908c", fontSize: 10, fontWeight: "700" },
  tabActive: { color: palette.accent },
});
