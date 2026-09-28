import type { Session } from "@supabase/supabase-js";
import { apiBase, supabase } from "./backend";
import { lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DeferredContent } from "./DeferredContent";
import type { LineAssignment, DeviceRecord } from "./Settings";
import { settingsTabFromSearch } from "./settings-navigation";
import webPackage from "../package.json";
import { SidebarSimple, TextAlignLeft, ArrowClockwise, ArrowRight, ChartBar, Headset, ShieldCheck, Lightning, ChatCircle, GearSix, Phone, Plus, Users, WarningCircle, X } from "@phosphor-icons/react";
import { Conversations } from "./Conversations";
import { Contacts } from "./Contacts";
import { PowerDialer } from "./PowerDialer";
import { CallTranscript } from "./CallTranscript";
import type { TranscriptTarget } from "@onoff/api-client";
import { CallDialog, NewConversation } from "./ConversationDialogs";
import { CallCreateActions, type CallActionContext } from "./CallCreateActions";
import { Avatar, EmptyState, Modal } from "./ui";
import { buildInbox, formatPhone, phoneKey, type Contact, type CallRecord, type Conversation, type MessageRecord } from "./conversation-model";
import { normalizePhoneNumber, type ServiceStatus } from "@onoff/contracts";
import { useContacts } from "./useContacts";
import { editedContactPhones } from "./contact-model";
import { ApiClientError, createApiClient, createSnapshot, getSmsSegmentInfo } from "@onoff/api-client";
import { clearOtherWorkspaceSnapshots, clearWorkspaceSnapshot, loadWorkspaceSnapshot, saveWorkspaceSnapshot, snapshotSignature } from "./workspace-snapshot";
import { ThreadCache, continuesThread, mergeById } from "./thread-cache";
import { createVoiceClient, type VoiceEvent } from "@onoff/voice-web";
import type { VoiceClient } from "@onoff/voice-contract";

const Admin = lazy(() => import("./Admin").then(module => ({ default: module.Admin })));
const Statistics = lazy(() => import("./Statistics").then(module => ({ default: module.Statistics })));
const Settings = lazy(() => import("./Settings").then(module => ({ default: module.Settings })));
const McpConsent = lazy(() => import("./McpIntegrations").then(module => ({ default: module.McpConsent })));
const CallCenter = lazy(() => import("./CallCenter").then(module => ({ default: module.CallCenter })));
const QueuePresence = lazy(() => import("./QueuePresence").then(module => ({ default: module.QueuePresence })));
const NumberPurchase = lazy(() => import("./NumberPurchase").then(module => ({ default: module.NumberPurchase })));
const CallFollowups = lazy(() => import("./CallFollowups").then(module => ({ default: module.CallFollowups })));

type Organization = { organization_id: string; role: "admin" | "member"; organizations: { id: string; name: string } | null };
type PendingSms = { message_id: string; organization_id: string; conversation_id: string; line_id: string; destination: string; body: string; idempotency_key: string };
type VoiceDiagnosticEvent = "voice_registration_failed" | "history_refresh_succeeded" | "history_refresh_failed";

function takeCallDraftFromUrl(): string {
  const url = new URL(window.location.href);
  const value = url.searchParams.get("callTo");
  if (value === null) return "";
  url.searchParams.delete("callTo");
  window.history.replaceState(window.history.state, "", url);
  return normalizePhoneNumber(value) ?? "";
}

export default function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!supabase);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [workspaceState, setWorkspaceState] = useState<"loading" | "ready" | "error">("loading");
  const [networkOnline, setNetworkOnline] = useState(() => navigator.onLine);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selectedOrg, setSelectedOrg] = useState("");
  const [lines, setLines] = useState<LineAssignment[]>([]);
  const [selectedLineId, setSelectedLineId] = useState("");
  const [numberPurchaseOpen, setNumberPurchaseOpen] = useState(false);
  const [adminRefresh, setAdminRefresh] = useState(0);
  const [services, setServices] = useState<ServiceStatus | null>(null);
  const [voiceRetry, setVoiceRetry] = useState(0);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactSearch, setContactSearch] = useState("");
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [destination, setDestination] = useState(takeCallDraftFromUrl);
  const [notice, setNotice] = useState("");
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [dialerOpen, setDialerOpen] = useState(Boolean(destination));
  const [contactEditorOpen, setContactEditorOpen] = useState(false);
  const [contactFormError, setContactFormError] = useState("");
  const [messagesState, setMessagesState] = useState<"loading" | "ready" | "error">("ready");
  const [historyCursors, setHistoryCursors] = useState<{ calls: string | null; conversations: string | null }>({ calls: null, conversations: null });
  const [messagesCursor, setMessagesCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [messageReload, setMessageReload] = useState(0);
  const drafts = useRef<Record<string, string>>({});
  const workspaceRequest = useRef(0);
  const workspaceSelection = useRef({ organizationId: "", lineId: "" });
  const historyScope = useRef("");
  const historyExpanded = useRef(false);
  // The last known inbox is shown while the current one loads; reopened threads reuse their messages.
  const hydratedUser = useRef("");
  const rememberedSelection = useRef({ organizationId: "", lineId: "" });
  const lastSnapshot = useRef("");
  const threadCache = useRef(new ThreadCache());
  const loadedConversationId = useRef("");
  const smsSubmitting = useRef(false);
  const [activeTab, setActiveTab] = useState<"conversations" | "contacts" | "powerdialer" | "settings" | "admin" | "center" | "statistics" | "followups">(() => settingsTabFromSearch(window.location.search) ? "settings" : "conversations");
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [conversationMessages, setConversationMessages] = useState<MessageRecord[]>([]);
  const [messageDestination, setMessageDestination] = useState("");
  const [messageBody, setMessageBody] = useState("");
  const [pendingSmsAttempt, setPendingSmsAttempt] = useState<{ signature: string; key: string } | null>(null);
  const [smsRecoveryState, setSmsRecoveryState] = useState<"checking" | "ready" | "unavailable">("checking");
  const [powerDialerLocked, setPowerDialerLocked] = useState(false);
  const callSubmitting = useRef(false);
  const powerDialerOwnsCall = useRef(false);
  const voiceActivity = useRef(false);
  const dialerListeners = useRef(new Set<(event: VoiceEvent) => void>());
  const subscribePowerDialer = useCallback((listener: (event: VoiceEvent) => void) => {
    dialerListeners.current.add(listener);
    return () => { dialerListeners.current.delete(listener); };
  }, []);
  const [voiceStatus, setVoiceStatus] = useState("Ligne inactive");
  const [voiceTabOwner, setVoiceTabOwner] = useState(false);
  const [voiceState, setVoiceState] = useState<"idle" | "connecting" | "ringing" | "active">("idle");
  const [providerCallSid, setProviderCallSid] = useState("");
  const [callContext, setCallContext] = useState<CallActionContext | null>(null);
  const [callEnded, setCallEnded] = useState(false);
  const [transcriptTarget, setTranscriptTarget] = useState<TranscriptTarget | null>(null);
  useEffect(() => { setTranscriptTarget(null); setProviderCallSid(""); setCallContext(null); setCallEnded(false); }, [session?.user.id, selectedOrg, selectedLineId]);
  const [incomingFrom, setIncomingFrom] = useState("");
  const [muted, setMuted] = useState(false);
  const voiceClient = useRef<VoiceClient | null>(null);
  const voiceUnsubscribe = useRef<(() => void) | null>(null);
  const voiceClientOrg = useRef("");
  const voiceSetup = useRef<Promise<void> | null>(null);
  const voiceOwnershipRelease = useRef<(() => void) | null>(null);
  const deviceRef = useRef<{ organizationId: string; id: string } | null>(null);
  const voiceRegisteredRef = useRef(false);
  const currentUserId = useRef("");
  const setVoiceRegistrationRef = useRef<(registered: boolean) => Promise<void>>(async () => undefined);
  const activeTabRef = useRef(activeTab);
  const selectedConversationIdRef = useRef(selectedConversationId);
  activeTabRef.current = activeTab;
  selectedConversationIdRef.current = selectedConversationId;
  const smsSegmentInfo = getSmsSegmentInfo(messageBody.trim());


  useEffect(() => {
    if (!supabase) return;
    let disposed = false;
    void supabase.auth.getSession().then(({ data, error }) => {
      if (disposed) return;
      if (error) setAuthError(error.message);
      setSession(data.session);
      setReady(true);
    }).catch(() => {
      if (!disposed) { setReady(true); setAuthError("Impossible de restaurer la session. Reconnectez-vous."); }
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      const nextUserId = nextSession?.user.id ?? "";
      if (currentUserId.current && currentUserId.current !== nextUserId) {
        clearWorkspaceSnapshot(currentUserId.current);
        threadCache.current.clear();
        loadedConversationId.current = "";
        hydratedUser.current = "";
        lastSnapshot.current = "";
        voiceOwnershipRelease.current?.();
        voiceOwnershipRelease.current = null;
        setVoiceTabOwner(false);
        setVoiceState("idle");
        voiceActivity.current = false;
        powerDialerOwnsCall.current = false;
        setIncomingFrom("");
        void setVoiceRegistrationRef.current(false);
        voiceUnsubscribe.current?.();
        voiceUnsubscribe.current = null;
        const client = voiceClient.current;
        voiceClient.current = null;
        voiceClientOrg.current = "";
        voiceRegisteredRef.current = false;
        deviceRef.current = null;
        void client?.destroy();
        setOrganizations([]);
        setSelectedOrg("");
        setLines([]);
        setSelectedLineId("");
        setNumberPurchaseOpen(false);
        setServices(null);
        setDevices([]);
        setCalls([]);
        setConversations([]);
        setSelectedConversationId("");
        setConversationMessages([]);
        setPendingSmsAttempt(null);
        setSmsRecoveryState("checking");
        drafts.current = {};
        workspaceRequest.current += 1;
        historyScope.current = "";
        historyExpanded.current = false;
        setMessageBody(""); setMessageDestination(""); setDestination("");
        setContactEditorOpen(false); setNewConversationOpen(false); setDialerOpen(false);
      }
      currentUserId.current = nextUserId;
      setSession(nextSession);
      if (event === "PASSWORD_RECOVERY") setPasswordRecovery(true);
    });
    return () => { disposed = true; listener.subscription.unsubscribe(); };
  }, []);

  useEffect(() => () => {
    voiceUnsubscribe.current?.();
    void voiceClient.current?.destroy();
    voiceClient.current = null;
  }, []);

  const authToken = session?.access_token;
  const tokenRef = useRef(authToken); tokenRef.current = authToken;
  const apiClient = useMemo(() => createApiClient({ baseUrl: apiBase, getAccessToken: () => tokenRef.current }), []);
  const loadCallAudio = useCallback(async (callId: string, signal: AbortSignal) => {
    const response = await fetch(`${apiBase}/v1/calls/${encodeURIComponent(callId)}/recording/audio`, { headers: { authorization: `Bearer ${tokenRef.current}` }, signal });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 || response.status === 404 ? "Cet audio n’est plus disponible ou vous n’y avez plus accès." : "Impossible de charger l’audio. Réessayez.");
    return response.blob();
  }, []);
  const directory = useContacts(session && selectedOrg ? `${session.user.id}:${selectedOrg}` : "", contactSearch,
    (query, cursor, signal) => apiClient.getPage<Contact>(`/v1/organizations/${selectedOrg}/contacts`, { limit: 50, cursor, query: { q: query || undefined }, signal }));
  const contacts = directory.contacts;
  const normalizedDestination = normalizePhoneNumber(destination);
  const destinationContact = normalizedDestination
    ? contacts.find(contact => contact.contact_phones.some(phone => phone.phone_number === normalizedDestination)) ?? null : null;
  const activeAssignment = useMemo(() => lines.find((item) => item.lines?.id === selectedLineId) ?? lines.find((item) => item.lines) ?? null, [lines, selectedLineId]);
  const activeLine = activeAssignment?.lines ?? null;
  const canPurchaseNumber = organizations.find((item) => item.organization_id === selectedOrg)?.role === "admin";
  const inbox = useMemo(() => buildInbox(activeLine?.id ?? "", conversations, calls), [activeLine?.id, conversations, calls]);
  const scopeRef = useRef({ org: selectedOrg, line: selectedLineId });
  scopeRef.current = { org: selectedOrg, line: selectedLineId };
  const conversationLocked = Boolean(pendingSmsAttempt) || smsRecoveryState !== "ready";
  const organizationName = organizations.find((item) => item.organization_id === selectedOrg)?.organizations?.name ?? "Mon espace";
  const canCall = Boolean(networkOnline && services?.voiceEnabled && !services.operationsPaused && voiceTabOwner && voiceRegisteredRef.current && activeLine?.voice_enabled && activeAssignment?.can_voice);
  const canSms = Boolean(networkOnline && services?.smsEnabled && !services.operationsPaused && activeLine?.sms_enabled && activeAssignment?.can_sms);
  const canBuy = Boolean(networkOnline && services?.numberPurchaseEnabled);
  const smsUnavailable = !networkOnline ? "Reconnectez-vous pour envoyer un SMS." : !services ? "Vérification du service SMS…" : services.operationsPaused ? services.pauseMessage ?? "Les envois sont suspendus." : !services.smsEnabled ? "Le service SMS est désactivé dans cet environnement." : !activeLine ? "Aucune ligne attribuée." : "Les SMS ne sont pas autorisés sur cette ligne.";

  function openConversation(number: string, id?: string | null): void {
    if (conversationLocked) return;
    const normalized = normalizePhoneNumber(number);
    if (!normalized) return;
    drafts.current[`${selectedLineId}:${phoneKey(messageDestination)}`] = messageBody;
    setMessageBody(drafts.current[`${selectedLineId}:${phoneKey(normalized)}`] ?? "");
    setMessageDestination(normalized);
    const smsId = id ?? conversations.find((item) => phoneKey(item.remoteNumber) === phoneKey(normalized))?.id ?? "";
    const cached = smsId ? threadCache.current.get(smsId) : undefined;
    loadedConversationId.current = cached ? smsId : "";
    setConversationMessages(cached?.messages ?? []);
    setMessagesCursor(cached?.cursor ?? null);
    setSelectedConversationId(smsId);
    setMessagesState(smsId && !cached ? "loading" : "ready");
    setMessageReload((value) => value + 1);
    setActiveTab("conversations");
    setNewConversationOpen(false);
  }

  function openCall(number = ""): void {
    if (powerDialerLocked || callSubmitting.current) { setActiveTab("powerdialer"); return; }
    if (voiceState === "idle" && !incomingFrom) { setDestination(number); setCallEnded(false); setCallContext(null); setProviderCallSid(""); }
    setDialerOpen(true);
  }

  function newContact(number = ""): void {
    setEditingContact(null);
    setContactName(""); setContactPhone(number); setContactEmail("");
    setContactFormError(""); setContactEditorOpen(true);
  }

  async function retryWorkspace(): Promise<void> {
    setWorkspaceState("loading");
    setMessageReload(value => value + 1);
    try {
      const [{ items }, status] = await Promise.all([
        api<{ items: Organization[] }>("/v1/organizations"), api<ServiceStatus>("/v1/services"),
      ]);
      setOrganizations(items); setServices(status);
      const next = items.some(item => item.organization_id === selectedOrg) ? selectedOrg : items[0]?.organization_id ?? "";
      if (next !== selectedOrg) {
        workspaceRequest.current += 1;
        setLines([]); setSelectedLineId(""); setCalls([]); setConversations([]);
        setSelectedConversationId(""); setConversationMessages([]); setMessageDestination(""); setMessageBody("");
        setSelectedOrg(next);
      }
      else { await refreshWorkspace(next); await directory.refresh(); }
      if (smsRecoveryState === "unavailable") await retrySmsRecovery();
      setWorkspaceState("ready");
    } catch (error) { setWorkspaceState("error"); setNotice(error instanceof Error ? error.message : "Chargement impossible."); }
  }

  async function loadMoreHistory(): Promise<void> {
    if (loadingMore || !selectedLineId) return;
    const lineId = selectedLineId;
    setLoadingMore(true);
    try {
      const [callPage, conversationPage] = await Promise.all([
        historyCursors.calls ? api<{ items: CallRecord[]; nextCursor: string | null }>(`/v1/lines/${lineId}/calls?limit=50&cursor=${encodeURIComponent(historyCursors.calls)}`) : null,
        historyCursors.conversations ? api<{ items: Conversation[]; nextCursor: string | null }>(`/v1/lines/${lineId}/conversations?limit=50&cursor=${encodeURIComponent(historyCursors.conversations)}`) : null,
      ]);
      if (scopeRef.current.line !== lineId) return;
      if (callPage) setCalls((current) => [...new Map([...current, ...callPage.items].map((item) => [item.id, item])).values()]);
      if (conversationPage) setConversations((current) => [...new Map([...current, ...conversationPage.items].map((item) => [item.id, item])).values()]);
      historyExpanded.current = true;
      setHistoryCursors({ calls: callPage?.nextCursor ?? null, conversations: conversationPage?.nextCursor ?? null });
    } catch (error) { setNotice(error instanceof Error ? error.message : "Historique indisponible."); }
    finally { setLoadingMore(false); }
  }

  async function loadOlderMessages(): Promise<void> {
    if (!messagesCursor || !selectedConversationId || loadingMore) return;
    const id = selectedConversationId;
    setLoadingMore(true);
    try {
      const page = await api<{ items: MessageRecord[]; nextCursor: string | null }>(`/v1/conversations/${id}/messages?limit=50&cursor=${encodeURIComponent(messagesCursor)}`);
      if (selectedConversationIdRef.current !== id) return;
      setConversationMessages((current) => [...new Map([...page.items, ...current].map((item) => [item.id, item])).values()]);
      setMessagesCursor(page.nextCursor);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Messages indisponibles."); }
    finally { setLoadingMore(false); }
  }

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    return apiClient.request<T>(path, init);
  }

  async function refreshOpenMessages(): Promise<void> {
    const id = selectedConversationIdRef.current;
    const org = scopeRef.current.org;
    if (!id || activeTabRef.current !== "conversations" || document.visibilityState !== "visible") return;
    const { items } = await api<{ items: MessageRecord[] }>(`/v1/conversations/${id}/messages?limit=50`);
    if (id !== selectedConversationIdRef.current || org !== scopeRef.current.org) return;
    setConversationMessages(current => [...new Map([...current, ...items].map(item => [item.id, item])).values()]);
    if (activeTabRef.current !== "conversations" || document.visibilityState !== "visible") return;
    await api(`/v1/conversations/${id}/read`, { method: "PUT", body: JSON.stringify({ lastReadMessageId: items.at(-1)?.id ?? null }) });
    if (id === selectedConversationIdRef.current && org === scopeRef.current.org) setConversations(current => current.map(conversation => conversation.id === id ? { ...conversation, unread: false } : conversation));
  }

  async function reportVoiceDiagnostic(event: VoiceDiagnosticEvent, durationMs?: number): Promise<void> {
    try {
      await api("/v1/diagnostics/voice", {
        method: "POST",
        body: JSON.stringify({ event, platform: "web", appVersion: webPackage.version, ...(durationMs === undefined ? {} : { durationMs }) }),
      });
    } catch { /* Diagnostics must never interrupt calling or history refresh. */ }
  }

  async function setVoiceRegistration(registered: boolean): Promise<void> {
    const device = deviceRef.current;
    voiceRegisteredRef.current = registered;
    if (!authToken || !device) return;
    try {
      await api(`/v1/devices/${device.id}/voice-state`, {
        method: "PUT",
        body: JSON.stringify({ registered }),
      });
    } catch (error) {
      if (registered) setNotice(error instanceof Error ? error.message : "La présence vocale n’a pas pu être actualisée.");
    }
  }
  setVoiceRegistrationRef.current = setVoiceRegistration;

  function selectOrganization(organizationId: string): void {
    if (smsRecoveryState !== "ready") {
      setNotice("Attendez la vérification des envois SMS avant de changer d’organisation.");
      return;
    }
    if (pendingSmsAttempt) {
      setNotice("Vérifiez d’abord le résultat du SMS avant de changer d’organisation.");
      return;
    }
    if (voiceState !== "idle" || powerDialerLocked || callSubmitting.current) {
      setNotice("Mettez le powerdialer en pause et terminez l’appel avant de changer d’organisation.");
      return;
    }
    if (organizationId === selectedOrg) return;
    workspaceRequest.current += 1;
    historyScope.current = "";
    historyExpanded.current = false;
    threadCache.current.clear();
    loadedConversationId.current = "";
    drafts.current[`${selectedLineId}:${phoneKey(messageDestination)}`] = messageBody;
    setLines([]);
    setSelectedLineId("");
    setDevices([]);
    setCalls([]);
    setConversations([]);
    setSelectedConversationId("");
    setConversationMessages([]);
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
    if (voiceState !== "idle" || powerDialerLocked || callSubmitting.current) {
      setNotice("Mettez le powerdialer en pause et terminez l’appel avant de changer de ligne.");
      return;
    }
    if (lineId === selectedLineId) return;
    workspaceRequest.current += 1;
    historyScope.current = "";
    historyExpanded.current = false;
    drafts.current[`${selectedLineId}:${phoneKey(messageDestination)}`] = messageBody;
    setCalls([]);
    setConversations([]);
    setSelectedConversationId("");
    setConversationMessages([]);
    setMessageDestination("");
    setMessageBody("");
    setHistoryCursors({ calls: null, conversations: null });
    setSelectedLineId(lineId);
  }

  async function shutdownVoiceClient(): Promise<void> {
    await setVoiceRegistration(false);
    voiceUnsubscribe.current?.();
    voiceUnsubscribe.current = null;
    const client = voiceClient.current;
    voiceClient.current = null;
    voiceClientOrg.current = "";
    await client?.destroy();
    setVoiceTabOwner(false);
  }

  async function ensureVoiceClient(orgId: string, lineId: string): Promise<void> {
    if (voiceClient.current && voiceClientOrg.current === orgId) return;
    if (voiceSetup.current) {
      await voiceSetup.current;
      if (voiceClient.current && voiceClientOrg.current === orgId) return;
    }
    const setup = (async () => {
      if (voiceClient.current) {
        await setVoiceRegistration(false);
        voiceUnsubscribe.current?.();
        await voiceClient.current.destroy();
        voiceClient.current = null;
        voiceClientOrg.current = "";
      }
      let currentDeviceId = deviceRef.current?.organizationId === orgId ? deviceRef.current.id : "";
      const deviceStorageKey = `onoff:web-device:${session?.user.id ?? ""}:${orgId}`;
      if (!currentDeviceId) {
        try {
          const storedId = window.localStorage.getItem(deviceStorageKey) ?? "";
          currentDeviceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storedId) ? storedId : "";
        } catch { /* The server remains the source of truth when browser storage is unavailable. */ }
      }
      if (!currentDeviceId) {
        const device = await api<{ id: string }>("/v1/devices", {
          method: "POST",
          body: JSON.stringify({ organizationId: orgId, platform: "web", label: navigator.platform || "Navigateur web" }),
        });
        currentDeviceId = device.id;
        try { window.localStorage.setItem(deviceStorageKey, currentDeviceId); } catch { /* A later tab may register a separate device if storage is blocked. */ }
      }
      deviceRef.current = { organizationId: orgId, id: currentDeviceId };
      const requestToken = () => api<{ token: string }>("/v1/voice/token", {
        method: "POST",
        body: JSON.stringify({ organizationId: orgId, lineId, deviceId: currentDeviceId }),
      });
      const token = await requestToken();
      const client = createVoiceClient();
      const unsubscribe = client.subscribe(handleVoiceEvent);
      const registrationStartedAt = Date.now();
      try {
        await client.register(token.token, async () => (await requestToken()).token);
        voiceClient.current = client;
        voiceUnsubscribe.current = unsubscribe;
        voiceClientOrg.current = orgId;
      } catch (error) {
        void reportVoiceDiagnostic("voice_registration_failed", Date.now() - registrationStartedAt);
        await setVoiceRegistration(false);
        unsubscribe();
        await client.destroy();
        throw error;
      }
    })();
    voiceSetup.current = setup;
    try {
      await setup;
    } finally {
      if (voiceSetup.current === setup) voiceSetup.current = null;
    }
  }

  async function refreshWorkspace(orgId = selectedOrg, preferredLineId = selectedLineId) {
    if (!orgId) return;
    const requestVersion = ++workspaceRequest.current;
    const isCurrent = () => requestVersion === workspaceRequest.current;
    workspaceSelection.current = { organizationId: orgId, lineId: selectedLineId };
    // Devices only matter for voice: they are applied when they arrive and never delay the inbox.
    // The outcome is captured so a failure is reported at the end, never as an unhandled rejection.
    const devicesOutcome = api<{ items: DeviceRecord[] }>("/v1/devices")
      .then(({ items }) => { if (isCurrent()) setDevices(items); return null; }, (error: unknown) => error);
    const lineResponse = await api<{ items: LineAssignment[] }>(`/v1/organizations/${orgId}/lines`);
    if (!isCurrent()) return;
    setLines(lineResponse.items);
    const assignment = lineResponse.items.find((item) => item.lines?.id === preferredLineId) ?? lineResponse.items.find((item) => item.lines);
    const line = assignment?.lines;
    // Selecting the line returned by this load must not start the same load again.
    workspaceSelection.current = { organizationId: orgId, lineId: line?.id ?? "" };
    setSelectedLineId(line?.id ?? "");
    if (line) {
      const preserveHistory = historyScope.current === line.id;
      const updateCursors = (cursors: Partial<typeof historyCursors>) => {
        if (!preserveHistory || !historyExpanded.current) setHistoryCursors((current) => ({ ...current, ...cursors }));
      };
      const emptyPage = { items: [], nextCursor: null };
      // Conversations and calls are shown as each one arrives; neither waits for the other.
      await Promise.all([
        (assignment?.can_sms ? api<{ items: Conversation[]; nextCursor: string | null }>(`/v1/lines/${line.id}/conversations?limit=50`) : Promise.resolve(emptyPage)).then((page) => {
          if (!isCurrent()) return;
          setConversations((current) => preserveHistory && assignment?.can_sms ? mergeById(current, page.items) : page.items);
          updateCursors({ conversations: page.nextCursor });
          historyScope.current = line.id;
        }),
        (assignment?.can_voice ? api<{ items: CallRecord[]; nextCursor: string | null }>(`/v1/lines/${line.id}/calls?limit=50`) : Promise.resolve(emptyPage)).then((page) => {
          if (!isCurrent()) return;
          setCalls((current) => preserveHistory && assignment?.can_voice ? mergeById(current, page.items) : page.items);
          updateCursors({ calls: page.nextCursor });
          historyScope.current = line.id;
        }),
      ]);
    } else if (isCurrent()) {
      setCalls([]);
      setConversations([]);
      setSelectedConversationId("");
      setSelectedLineId("");
      setMessageDestination("");
      setConversationMessages([]);
      setHistoryCursors({ calls: null, conversations: null });
      historyScope.current = "";
    }
    const devicesError = await devicesOutcome;
    if (devicesError) throw devicesError;
  }

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
    if (pending.conversation_id !== selectedConversationIdRef.current) {
      loadedConversationId.current = "";
      setConversationMessages([]);
      setMessagesCursor(null);
    }
    setSelectedConversationId(pending.conversation_id);
    setActiveTab("conversations");
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

  // Shows the last known inbox of this user, once per sign-in, before anything is fetched. It only
  // fills empty state and never starts a request itself: the normal load below replaces it.
  // Returns the organization and line that inbox belonged to.
  function hydrateFromSnapshot(): { organizationId: string; lineId: string } {
    const userId = session?.user.id ?? "";
    if (userId && hydratedUser.current !== userId) {
      hydratedUser.current = userId;
      clearOtherWorkspaceSnapshots(userId);
      rememberedSelection.current = { organizationId: "", lineId: "" };
      const snapshot = workspaceSelection.current.organizationId ? null : loadWorkspaceSnapshot<Organization, LineAssignment>(userId);
      if (snapshot) {
        rememberedSelection.current = { organizationId: snapshot.organizationId, lineId: snapshot.lineId };
        workspaceSelection.current = { organizationId: snapshot.organizationId, lineId: snapshot.lineId };
        setOrganizations(snapshot.organizations);
        setSelectedOrg(snapshot.organizationId);
        setLines(snapshot.lines);
        setSelectedLineId(snapshot.lineId);
        setConversations(snapshot.conversations);
        setCalls(snapshot.calls);
      }
    }
    return rememberedSelection.current;
  }

  useEffect(() => {
    if (!authToken) {
      setWorkspaceState("ready");
      setSmsRecoveryState("checking");
      setPendingSmsAttempt(null);
      setOrganizations([]);
      setLines([]);
      setServices(null);
      setCalls([]);
      setConversations([]);
      setDevices([]);
      setConversationMessages([]);
      setSelectedOrg("");
      setSelectedLineId("");
      setSelectedConversationId("");
      setMessageDestination("");
      deviceRef.current = null;
      return;
    }
    let disposed = false;
    setWorkspaceState("loading");
    setSmsRecoveryState("checking");
    // Nothing selected yet: a first load (or its repeat under StrictMode) that may resume the remembered inbox.
    const firstLoad = !selectedOrg;
    const remembered = hydrateFromSnapshot();
    const pendingRequest = api<{ items: PendingSms[] }>("/v1/messages/pending")
      .then(result => ({ ...result, ok: true as const }), error => ({ items: [] as PendingSms[], ok: false as const, error }));
    void Promise.all([api<{ items: Organization[] }>("/v1/organizations"), api<ServiceStatus>("/v1/services"), pendingRequest])
      .then(async ([{ items }, status, pending]) => {
        if (disposed) return;
        setOrganizations(items);
        setServices(status);
        const preferredOrg = selectedOrg || remembered.organizationId;
        const next = preferredOrg && items.some((item) => item.organization_id === preferredOrg)
          ? preferredOrg
          : items[0]?.organization_id ?? "";
        if (pending.items.length) await restorePendingSmsAttempt(() => !disposed, pending.items);
        else {
          setSelectedOrg(next);
          // Nothing uncertain to recover: conversations are usable while the history finishes loading.
          if (pending.ok) setSmsRecoveryState("ready");
          if (next) await refreshWorkspace(next, firstLoad && next === remembered.organizationId ? remembered.lineId : undefined);
        }
        if (!pending.ok) throw pending.error;
        if (!disposed) {
          setSmsRecoveryState("ready");
          setWorkspaceState("ready");
        }
      })
      .catch(() => {
        if (disposed) return;
        setSmsRecoveryState("unavailable");
        setWorkspaceState("error");
        setNotice("Les données de l’espace ou l’état des SMS ne sont pas disponibles. Vérifiez la connexion puis réessayez.");
      });
    return () => { disposed = true; };
  // refreshWorkspace reads the current bearer token and organization selection.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  useEffect(() => {
    if (!selectedOrg || !authToken) return;
    if (workspaceSelection.current.organizationId === selectedOrg && workspaceSelection.current.lineId === selectedLineId) return;
    const request = workspaceRequest.current + 1;
    setWorkspaceState("loading");
    void refreshWorkspace(selectedOrg)
      .then(() => { if (request === workspaceRequest.current) setWorkspaceState("ready"); })
      .catch((error: Error) => { if (request === workspaceRequest.current) { setWorkspaceState("error"); setNotice(error.message); } });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrg, selectedLineId]);

  // Remember the inbox once it is fully loaded; forget it when the user has no line left.
  useEffect(() => {
    const userId = session?.user.id;
    if (!userId || workspaceState !== "ready" || !selectedOrg) return;
    if (!activeLine) { if (!workspaceSelection.current.lineId && lines.every((item) => !item.lines)) clearWorkspaceSnapshot(userId); return; }
    const timer = window.setTimeout(() => {
      const snapshot = createSnapshot({ userId, organizationId: selectedOrg, lineId: activeLine.id, organizations, lines, conversations, calls });
      const signature = snapshotSignature(snapshot);
      if (signature === lastSnapshot.current) return;
      lastSnapshot.current = signature;
      saveWorkspaceSnapshot(snapshot);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [session?.user.id, workspaceState, selectedOrg, activeLine?.id, organizations, lines, conversations, calls]);

  useEffect(() => {
    if (!messageDestination || selectedConversationId) return;
    const conversation = conversations.find((item) => item.lineId === activeLine?.id && phoneKey(item.remoteNumber) === phoneKey(messageDestination));
    if (conversation) setSelectedConversationId(conversation.id);
  }, [conversations, messageDestination, selectedConversationId, activeLine?.id]);

  useEffect(() => {
    if (!selectedConversationId || !authToken) {
      loadedConversationId.current = "";
      setConversationMessages([]);
      setMessagesCursor(null);
      setMessagesState("ready");
      return;
    }
    if (activeTab !== "conversations") return;
    let disposed = false;
    const conversationId = selectedConversationId;
    // A thread opened before shows its messages at once while the fresh ones load.
    const cached = threadCache.current.get(conversationId);
    loadedConversationId.current = cached ? conversationId : "";
    setConversationMessages(cached?.messages ?? []);
    setMessagesCursor(cached?.cursor ?? null);
    setMessagesState(cached ? "ready" : "loading");
    void api<{ items: MessageRecord[]; nextCursor: string | null }>(`/v1/conversations/${conversationId}/messages?limit=50`)
      .then(async ({ items, nextCursor }) => {
        if (disposed) return;
        // Older pages already loaded stay visible when this page continues them; after a long absence
        // it replaces them, or the messages in between would be missing and out of reach.
        const continues = Boolean(cached) && continuesThread(cached!.messages, items, nextCursor);
        setConversationMessages((current) => continues ? mergeById(current, items) : items);
        setMessagesCursor(continues ? cached!.cursor : nextCursor);
        setMessagesState("ready");
        loadedConversationId.current = conversationId;
        if (document.visibilityState === "visible") {
          try {
            await api(`/v1/conversations/${conversationId}/read`, {
              method: "PUT", body: JSON.stringify({ lastReadMessageId: items.at(-1)?.id ?? null }),
            });
            if (!disposed) setConversations((current) => current.map((conversation) => conversation.id === conversationId ? { ...conversation, unread: false } : conversation));
          } catch { if (!disposed) setNotice("Les messages sont chargés, mais leur état de lecture n’a pas pu être enregistré."); }
        }
      })
      .catch((error: Error) => {
        if (disposed) return;
        // Access removed: never keep showing what was cached for this thread.
        if (error instanceof ApiClientError && (error.status === 403 || error.status === 404)) {
          threadCache.current.delete(conversationId);
          loadedConversationId.current = "";
          setConversationMessages([]);
          setMessagesCursor(null);
        }
        setMessagesState("error"); setNotice(error.message);
      });
    return () => { disposed = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken, selectedConversationId, activeTab, messageReload]);

  // Remember the pages of the open thread; only once they are known to belong to it.
  useEffect(() => {
    if (!selectedConversationId || messagesState !== "ready" || loadedConversationId.current !== selectedConversationId || !conversationMessages.length) return;
    threadCache.current.set(selectedConversationId, { messages: conversationMessages, cursor: messagesCursor });
  }, [selectedConversationId, conversationMessages, messagesCursor, messagesState]);

  useEffect(() => {
    const realtimeClient = supabase;
    if (!realtimeClient || !authToken || !selectedOrg) return;
    let disposed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const channels: Array<ReturnType<typeof realtimeClient.channel>> = [];
    const refresh = () => {
      if (disposed || refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refreshWorkspace(selectedOrg).catch((error: Error) => setNotice(error.message));
        void refreshOpenMessages().catch((error: Error) => setNotice(error.message));
      }, 150);
    };
    const refreshFromEvent = (payload: unknown) => {
      if (disposed || !payload || typeof payload !== "object") return;
      const kind = (payload as { kind?: unknown }).kind;
      const reportError = (error: Error) => { if (!disposed) setNotice(error.message); };
      if (kind === "contact") {
        void directory.refresh();
      } else if (kind === "device") {
        void api<{ items: DeviceRecord[] }>("/v1/devices")
          .then(({ items }) => { if (!disposed) setDevices(items); }).catch(reportError);
      } else if (kind === "call" && activeLine?.id) {
        void api<{ items: CallRecord[] }>(`/v1/lines/${activeLine.id}/calls?limit=50`)
          .then(({ items }) => { if (!disposed) setCalls((current) => [...new Map([...current, ...items].map((item) => [item.id, item])).values()]); }).catch(reportError);
      } else if (kind === "message" && activeLine?.id) {
        void api<{ items: Conversation[] }>(`/v1/lines/${activeLine.id}/conversations?limit=50`)
          .then(({ items }) => { if (!disposed) setConversations((current) => [...new Map([...current, ...items].map((item) => [item.id, item])).values()]); }).catch(reportError);
        const conversationId = selectedConversationIdRef.current;
        if (conversationId) {
          void api<{ items: MessageRecord[] }>(`/v1/conversations/${conversationId}/messages?limit=50`)
            .then(async ({ items }) => {
              if (disposed || selectedConversationIdRef.current !== conversationId) return;
              setConversationMessages((current) => [...new Map([...current, ...items].map((item) => [item.id, item])).values()]);
              if (activeTabRef.current === "conversations" && document.visibilityState === "visible") {
                await api(`/v1/conversations/${conversationId}/read`, {
                  method: "PUT",
                  body: JSON.stringify({ lastReadMessageId: items.at(-1)?.id ?? null }),
                });
                if (!disposed) setConversations((current) => current.map((conversation) => conversation.id === conversationId ? { ...conversation, unread: false } : conversation));
              }
            }).catch(reportError);
        }
      }
    };
    const topics = [`org:${selectedOrg}:contacts`, `user:${session.user.id}:devices`];
    if (activeLine?.id && activeAssignment?.can_voice) topics.push(`line:${activeLine.id}:voice`);
    if (activeLine?.id && activeAssignment?.can_sms) topics.push(`line:${activeLine.id}:sms`);
    void realtimeClient.realtime.setAuth(authToken).then(() => {
      if (disposed) return;
      for (const topic of topics) {
        const channel = realtimeClient.channel(topic, { config: { private: true } })
          .on("broadcast", { event: "onoff.activity" }, refreshFromEvent);
        let subscribedBefore = false;
        channel.subscribe((status) => {
          if (status === "SUBSCRIBED" && subscribedBefore) refresh();
          if (status === "SUBSCRIBED") subscribedBefore = true;
        });
        channels.push(channel);
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      for (const channel of channels) void realtimeClient.removeChannel(channel);
    };
  // Invalidation payloads contain IDs/status only; read current state from the API.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken, selectedOrg, activeLine?.id, activeAssignment?.can_voice, activeAssignment?.can_sms, contactSearch, selectedConversationId]);

  useEffect(() => {
    if (!authToken || !selectedOrg) return;
    const refreshWhenVisible = () => {
      if (navigator.onLine && document.visibilityState === "visible") {
        void refreshWorkspace(selectedOrg).catch((error: Error) => setNotice(error.message));
        void directory.refresh();
        void refreshOpenMessages().catch((error: Error) => setNotice(error.message));
      }
    };
    const markOnline = () => setNetworkOnline(true);
    const markOffline = () => setNetworkOnline(false);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    window.addEventListener("online", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
      window.removeEventListener("online", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken, selectedOrg, contactSearch]);

  useEffect(() => {
    if (!session?.user.id || !services?.voiceEnabled || !selectedOrg || !activeLine?.id || !activeLine.voice_enabled || !activeAssignment?.can_voice) {
      setVoiceTabOwner(false);
      void shutdownVoiceClient();
      if (!authToken) deviceRef.current = null;
      setVoiceStatus(!services ? "Vérification du service vocal…" : !services.voiceEnabled ? "Les appels sont désactivés dans cet environnement." : "Aucune ligne vocale autorisée.");
      return;
    }
    let disposed = false;
    const ownerController = new AbortController();
    const orgId = selectedOrg;
    if (!navigator.locks) {
      setVoiceTabOwner(false);
      setVoiceStatus("La réservation d’onglet vocal nécessite une origine sécurisée et un navigateur compatible.");
      return () => { disposed = true; };
    }
    setVoiceTabOwner(false);
    setVoiceStatus("Voix active dans un autre onglet; reprise automatique à sa fermeture.");
    let releaseOwnership!: () => void;
    const ownershipLifetime = new Promise<void>((resolve) => { releaseOwnership = resolve; });
    voiceOwnershipRelease.current = releaseOwnership;
    void navigator.locks.request(`onoff:voice-owner:${session?.user.id ?? "unknown"}`, {
      mode: "exclusive",
      signal: ownerController.signal,
    }, async () => {
      if (disposed) return;
      setVoiceTabOwner(true);
      let heartbeat: number | undefined;
      try {
        await ensureVoiceClient(orgId, activeLine.id);
        if (disposed) return;
        setVoiceStatus("Prête à recevoir les appels");
        heartbeat = window.setInterval(() => {
          if (voiceRegisteredRef.current) void setVoiceRegistration(true);
        }, 30_000);
        await ownershipLifetime;
      } catch (error) {
        if (!disposed) setVoiceStatus(error instanceof Error ? error.message : "Service vocal en attente");
      } finally {
        releaseOwnership();
        if (heartbeat !== undefined) window.clearInterval(heartbeat);
        if (voiceOwnershipRelease.current === releaseOwnership) voiceOwnershipRelease.current = null;
        await shutdownVoiceClient();
      }
    }).catch((error: unknown) => {
      if (!disposed && !(error instanceof DOMException && error.name === "AbortError")) {
        setVoiceTabOwner(false);
        setVoiceStatus(error instanceof Error ? error.message : "La réservation de l’appareil vocal a échoué.");
      }
    });
    return () => {
      disposed = true;
      ownerController.abort();
      releaseOwnership();
      if (voiceOwnershipRelease.current === releaseOwnership) voiceOwnershipRelease.current = null;
    };
  // Keep one Twilio Device registered for this browser profile across its tabs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrg, activeLine?.id, activeLine?.voice_enabled, activeAssignment?.can_voice, session?.user.id, services?.voiceEnabled, voiceRetry]);

  async function signOut() {
    if (!supabase) return;
    setBusy(true);
    try { const { error } = await supabase.auth.signOut(); if (error) throw error; }
    catch (error) { setNotice(error instanceof Error ? error.message : "Déconnexion impossible. Réessayez."); }
    finally { setBusy(false); }
  }

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setAuthError("");
    try {
      if (!supabase) throw new Error("Configuration Supabase manquante.");
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Connexion impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function sendPasswordReset() {
    setAuthError("");
    setBusy(true);
    try {
      if (!supabase || !email.trim()) throw new Error("Saisissez d’abord votre adresse email.");
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
      if (error) throw error;
      setAuthError("Un lien de réinitialisation a été envoyé si cette adresse possède un compte.");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Le lien de réinitialisation n’a pas pu être envoyé.");
    } finally { setBusy(false); }
  }

  async function updateRecoveredPassword(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setAuthError("");
    try {
      if (!supabase) throw new Error("Configuration Supabase manquante.");
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setPasswordRecovery(false);
      setNewPassword("");
      setAuthError("Votre mot de passe a été modifié.");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Le mot de passe n’a pas pu être modifié.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeDevice(deviceId: string) {
    setBusy(true);
    try {
      await api(`/v1/devices/${deviceId}/revoke`, { method: "POST" });
      if (deviceRef.current?.id === deviceId) {
        try {
          window.localStorage.removeItem(`onoff:web-device:${currentUserId.current}:${deviceRef.current.organizationId}`);
        } catch { /* A revoked id will be rejected by the server on its next use. */ }
        voiceOwnershipRelease.current?.();
        voiceOwnershipRelease.current = null;
        setVoiceTabOwner(false);
        deviceRef.current = null;
        voiceUnsubscribe.current?.();
        voiceUnsubscribe.current = null;
        await voiceClient.current?.destroy();
        voiceClient.current = null;
        voiceClientOrg.current = "";
        setVoiceStatus("Cet appareil a été révoqué.");
      }
      await refreshWorkspace();
      setNotice("L’appareil a été révoqué.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "L’appareil n’a pas pu être révoqué.");
    } finally {
      setBusy(false);
    }
  }

  async function createContact(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedOrg) return;
    const phone = contactPhone.trim() ? normalizePhoneNumber(contactPhone) : null;
    if (contactPhone.trim() && !phone) {
      setContactFormError("Saisissez un numéro international ou un numéro français à 10 chiffres.");
      return;
    }
    setBusy(true);
    setContactFormError("");
    try {
      const payload = JSON.stringify({ displayName: contactName.trim(), email: contactEmail.trim() || null, phones: editedContactPhones(editingContact, phone) });
      if (editingContact) {
        await api(`/v1/contacts/${editingContact.id}`, { method: "PATCH", body: JSON.stringify({ ...JSON.parse(payload), version: editingContact.version }) });
      } else {
        await api(`/v1/organizations/${selectedOrg}/contacts`, { method: "POST", body: payload });
      }
      const wasEditing = Boolean(editingContact);
      setEditingContact(null);
      setContactName("");
      setContactPhone("");
      setContactEmail("");
      setContactEditorOpen(false);
      await directory.refresh();
      setNotice(wasEditing ? "Contact modifié." : "Contact ajouté au carnet partagé.");
      void refreshWorkspace().catch(() => setNotice("Contact enregistré. Actualisez les conversations pour recharger son nom."));
    } catch (error) {
      setContactFormError(error instanceof Error ? error.message : "Le contact n’a pas pu être enregistré.");
    } finally {
      setBusy(false);
    }
  }

  function beginEditContact(contact: Contact) {
    setContactEditorOpen(true);
    setContactFormError("");
    setEditingContact(contact);
    setContactName(contact.display_name);
    setContactPhone(contact.contact_phones[0]?.phone_number ?? "");
    setContactEmail(contact.email ?? "");
  }

  async function archiveContact(contact: Contact) {
    setBusy(true);
    try {
      await api(`/v1/contacts/${contact.id}`, { method: "DELETE" });
      if (editingContact?.id === contact.id) {
        setEditingContact(null);
        setContactName("");
        setContactPhone("");
        setContactEmail("");
      }
      await directory.refresh();
      setNotice("Contact archivé.");
      void refreshWorkspace().catch(() => setNotice("Contact archivé. Actualisez les conversations pour recharger leurs noms."));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Le contact n’a pas pu être archivé.");
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (smsSubmitting.current || !messageBody.trim()) return;
    if (smsRecoveryState !== "ready") {
      setNotice("Les envois SMS précédents doivent être vérifiés avant un nouvel envoi.");
      return;
    }
    if (!canSms || !selectedOrg || !activeLine) { setNotice(smsUnavailable); return; }
    const normalizedDestination = messageDestination.replace(/[\s().-]/g, "");
    if (!/^\+[1-9]\d{7,14}$/.test(normalizedDestination)) {
      setNotice("Saisissez un numéro international au format +32… .");
      return;
    }
    const requestBody = { organizationId: selectedOrg, lineId: activeLine.id, destination: normalizedDestination, body: messageBody.trim() };
    const signature = JSON.stringify(requestBody);
    if (pendingSmsAttempt && pendingSmsAttempt.signature !== signature) {
      setNotice("Le SMS précédent a un résultat incertain. Vérifiez-le avant de modifier ou renvoyer le texte.");
      return;
    }
    smsSubmitting.current = true;
    const isRetry = Boolean(pendingSmsAttempt);
    const idempotencyKey = pendingSmsAttempt?.key ?? crypto.randomUUID();
    if (!pendingSmsAttempt) setPendingSmsAttempt({ signature, key: idempotencyKey });
    setBusy(true);
    setNotice("");
    let result: { id: string; conversationId: string; status: string; submissionConfirmed?: boolean };
    try {
      result = await api<{ id: string; conversationId: string; status: string; submissionConfirmed?: boolean }>("/v1/messages", {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      if (!isRetry && error instanceof ApiClientError && error.status >= 400 && error.status < 500) setPendingSmsAttempt(null);
      setNotice(error instanceof Error ? error.message : "Le message n’a pas pu être préparé.");
      smsSubmitting.current = false;
      setBusy(false);
      return;
    }
    setMessageDestination(normalizedDestination);
    setSelectedConversationId(result.conversationId);
    const uncertain = !result.submissionConfirmed && (result.status === "unknown" || result.status === "submitting");
    if (uncertain) {
      setNotice("Le résultat de l’envoi est en cours de vérification. Le message ne sera pas renvoyé automatiquement.");
      } else if (result.status === "failed" || result.status === "undelivered") {
        setPendingSmsAttempt(null);
        setNotice("Le fournisseur indique que le message n’a pas été remis. Vous pouvez le corriger ou le renvoyer.");
      } else {
        setPendingSmsAttempt(null);
        setMessageBody("");
        delete drafts.current[`${activeLine.id}:${phoneKey(normalizedDestination)}`];
        setNotice("Message transmis. La livraison sera indiquée dans la conversation.");
    }
    try {
      await refreshWorkspace();
      const messages = await api<{ items: MessageRecord[] }>(`/v1/conversations/${result.conversationId}/messages?limit=50`);
      if (selectedConversationIdRef.current === result.conversationId) setConversationMessages((current) => [...new Map([...current, ...messages.items].map((item) => [item.id, item])).values()]);
    } catch { /* Keep the send result visible; the next refresh will reload persisted data. */ }
    smsSubmitting.current = false;
    setBusy(false);
  }

  function handleVoiceEvent(event: VoiceEvent) {
    const wasPowerDialer = powerDialerOwnsCall.current;
    if (["incoming", "connecting", "ringing", "active"].includes(event.type)) voiceActivity.current = true;
    if (event.type === "ended") voiceActivity.current = false;
    if (powerDialerOwnsCall.current || ["incoming", "unavailable", "reconnecting"].includes(event.type)) {
      for (const listener of dialerListeners.current) listener(event);
    }
    if (event.type === "ended") powerDialerOwnsCall.current = false;
    switch (event.type) {
      case "ready": void setVoiceRegistration(true); setVoiceStatus("Prête à appeler"); break;
      case "unavailable": void setVoiceRegistration(false); setVoiceStatus(event.message); setNotice(event.message); break;
      case "incoming": setCallContext({ key: crypto.randomUUID(), number: event.from }); setCallEnded(false); setProviderCallSid(""); setDestination(event.from); setIncomingFrom(event.from); setVoiceState("ringing"); setDialerOpen(true); setVoiceStatus("Appel entrant"); break;
      case "connecting": setProviderCallSid(""); setVoiceState("connecting"); setVoiceStatus("Connexion en cours…"); break;
      case "ringing": setVoiceState("ringing"); setVoiceStatus("Le destinataire sonne…"); break;
      case "active": setProviderCallSid(event.providerCallSid ?? ""); setCallContext(context => context && event.providerCallSid ? { ...context, providerCallSid: event.providerCallSid } : context); setVoiceState("active"); setIncomingFrom(""); setVoiceStatus("En communication"); break;
      case "reconnecting": setVoiceStatus("Reconnexion de l’appel…"); break;
      case "reconnected": setVoiceState("active"); setVoiceStatus("En communication"); break;
      case "ended":
        setVoiceState("idle"); setIncomingFrom(""); setMuted(false); setCallEnded(!wasPowerDialer); setDialerOpen(!wasPowerDialer);
        setVoiceStatus(event.reason === "completed" ? "Appel terminé" : "Appel interrompu");
        if (selectedOrg) {
          const refreshStartedAt = Date.now();
          void refreshWorkspace(selectedOrg)
            .then(() => reportVoiceDiagnostic("history_refresh_succeeded", Date.now() - refreshStartedAt))
            .catch(() => reportVoiceDiagnostic("history_refresh_failed", Date.now() - refreshStartedAt));
        }
        break;
      case "muted": setMuted(event.muted); break;
    }
  }

  async function requestMicrophoneAccess(): Promise<void> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Pour appeler, ouvrez Onoff depuis une adresse HTTPS et autorisez le microphone dans le navigateur.");
    }
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError")) {
        throw new Error("Le microphone est bloqué. Autorisez-le dans les permissions du site, puis réessayez.");
      }
      if (error instanceof DOMException && error.name === "NotFoundError") {
        throw new Error("Aucun microphone n’est disponible sur cet appareil.");
      }
      throw error;
    } finally {
      for (const track of stream?.getTracks() ?? []) track.stop();
    }
  }

  async function startVoiceCall(number = destination, shouldContinue: () => boolean = () => true, fromPowerDialer = false): Promise<string> {
    if (callSubmitting.current || voiceActivity.current || voiceState !== "idle" || incomingFrom) throw new Error("Un appel est déjà en cours.");
    if (!voiceTabOwner) {
      throw new Error("Les appels sont actifs dans un autre onglet. Fermez-le pour reprendre ici.");
    }
    if (!canCall || !selectedOrg || !activeLine) throw new Error("La ligne vocale n’est pas disponible.");
    const normalizedDestination = normalizePhoneNumber(number);
    if (!normalizedDestination) {
      throw new Error("Saisissez un numéro international ou un numéro français à 10 chiffres.");
    }
    callSubmitting.current = true;
    setBusy(true);
    setNotice("");
    let unusedIntentId: string | null = null;
    let transportStarted = false;
    const userId = currentUserId.current;
    const assertCallStillAllowed = () => {
      if (!shouldContinue() || !navigator.onLine) throw new Error("Préparation interrompue. Reprenez la session pour appeler.");
      if (voiceActivity.current) throw new Error("Un autre appel est arrivé pendant la préparation.");
      if (currentUserId.current !== userId || scopeRef.current.org !== selectedOrg || scopeRef.current.line !== activeLine.id) throw new Error("La ligne a changé pendant la préparation.");
    };
    try {
      await requestMicrophoneAccess();
      assertCallStillAllowed();
      await ensureVoiceClient(selectedOrg, activeLine.id);
      assertCallStillAllowed();
      const currentDeviceId = deviceRef.current?.organizationId === selectedOrg ? deviceRef.current.id : "";
      if (!currentDeviceId) throw new Error("Cet appareil n’est pas enregistré sur cette organisation.");
      const intent = await api<{ id: string }>("/v1/call-intents", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ organizationId: selectedOrg, lineId: activeLine.id, deviceId: currentDeviceId, destination: normalizedDestination }),
      });
      unusedIntentId = intent.id;
      const client = voiceClient.current;
      if (!client) throw new Error("La ligne vocale n’a pas pu s’enregistrer.");
      assertCallStillAllowed();
      powerDialerOwnsCall.current = fromPowerDialer;
      setCallContext({ key: intent.id, number: normalizedDestination, intentId: intent.id });
      setCallEnded(false); setProviderCallSid(""); setDestination(normalizedDestination);
      transportStarted = true;
      await client.startCall({ destination: normalizedDestination, intentId: intent.id });
      unusedIntentId = null;
      setDestination(normalizedDestination);
      return intent.id;
    } catch (error) {
      if (unusedIntentId) {
        try { await api(`/v1/call-intents/${unusedIntentId}/cancel`, { method: "POST" }); } catch { /* The reservation still expires through the server's bounded cleanup. */ }
      }
      powerDialerOwnsCall.current = false;
      if (transportStarted || !voiceActivity.current) {
        voiceActivity.current = false;
        setVoiceState("idle");
        setVoiceStatus("Appel impossible");
      }
      setNotice(error instanceof Error ? error.message : "L’appel n’a pas pu démarrer.");
      throw error;
    } finally {
      callSubmitting.current = false;
      setBusy(false);
    }
  }

  // The extension injects this gesture only into the configured application's origin.
  // URL drafts alone never trigger an outbound call.
  useEffect(() => {
    if (!ready || (session && workspaceState === "loading")) return;
    document.documentElement.setAttribute("data-onoff-call-bridge", "ready");
    const onExtensionCall = (event: Event) => {
      const number = normalizePhoneNumber(typeof (event as CustomEvent).detail === "string" ? (event as CustomEvent<string>).detail : "");
      const respond = (message: string) => window.dispatchEvent(new CustomEvent("onoff:call-result", { detail: message }));
      if (!number) { respond("Numéro invalide."); return; }
      if (!session || passwordRecovery) { respond("Connectez-vous à Onoff, puis relancez l’appel depuis l’extension."); return; }
      if (busy || powerDialerLocked || callSubmitting.current || voiceActivity.current || voiceState !== "idle" || incomingFrom) {
        respond("Un appel ou une opération est déjà en cours dans Onoff."); return;
      }
      if (!canCall && voiceTabOwner && !voiceRegisteredRef.current && services?.voiceEnabled && activeLine?.voice_enabled && activeAssignment?.can_voice) { respond("loading"); return; }
      setDestination(number);
      setDialerOpen(true);
      if (!canCall) { respond("La ligne vocale n’est pas prête. Vérifiez votre ligne dans Onoff, puis réessayez."); return; }
      respond("started");
      void startVoiceCall(number).catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Appel impossible."));
    };
    window.addEventListener("onoff:call", onExtensionCall);
    return () => {
      document.documentElement.removeAttribute("data-onoff-call-bridge");
      window.removeEventListener("onoff:call", onExtensionCall);
    };
  });

  if (!ready) return <div className="boot-screen"><span className="brand-mark">o</span><span>Ouverture de votre espace…</span></div>;

  if (!session || passwordRecovery) return (
    <main className="auth-shell">
      <a className="brand auth-brand" href="/" aria-label="Onoff, accueil"><span className="brand-mark">o</span><span>onoff</span></a>
      <section className="auth-panel">
        <div className="auth-copy"><span className="auth-eyebrow">VOTRE ESPACE ONOFF</span><h1>{passwordRecovery ? "Nouveau mot de passe" : "Reprenons le fil."}</h1><p>{passwordRecovery ? "Choisissez votre nouveau mot de passe." : "Vos conversations vous attendent."}</p></div>
        <form className="auth-form" onSubmit={passwordRecovery ? updateRecoveredPassword : signIn}>
          {passwordRecovery ? <label className="field-label">Nouveau mot de passe<input autoComplete="new-password" type="password" minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required placeholder="8 caractères minimum" /></label> : <><label className="field-label">Email professionnel<input autoComplete="username" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="nom@entreprise.com" /></label><label className="field-label">Mot de passe<input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required placeholder="Votre mot de passe" /></label></>}
          {authError && <p className="form-error" role="status">{authError}</p>}
          {!supabase && <p className="form-note">La connexion n’est pas encore configurée pour cet environnement.</p>}
          <button className="button button-primary button-wide" disabled={busy || !supabase}>{busy ? "Connexion…" : passwordRecovery ? "Enregistrer le mot de passe" : "Se connecter"}<ArrowRight size={18} /></button>
          {!passwordRecovery && <button type="button" className="auth-link" disabled={busy || !supabase} onClick={() => void sendPasswordReset()}>Mot de passe oublié ?</button>}
        </form>
      </section>
      <p className="auth-foot">Accès privé · Comptes créés par un administrateur</p>
    </main>
  );

  const authorizationId = new URLSearchParams(window.location.search).get("authorization_id");
  if (authorizationId) return <DeferredContent fallback={<p role="status">Chargement…</p>}><McpConsent api={api} authorizationId={authorizationId} organizations={organizations}/></DeferredContent>;
  const activeDevices = devices.filter((device) => device.organization_id === selectedOrg);
  const unreadCount = conversations.filter((conversation) => conversation.unread).length;
  const duplicateContact = normalizePhoneNumber(contactPhone) ? contacts.find((contact) => contact.id !== editingContact?.id && contact.contact_phones.some((phone) => phone.phone_number === normalizePhoneNumber(contactPhone))) : null;
  const sectionTitle = activeTab === "followups" ? "Tickets & deals" : activeTab === "statistics" ? "Statistiques" : activeTab === "center" ? "IVR & files d’attente" : activeTab === "admin" ? "Administration" : activeTab === "powerdialer" ? "Powerdialer" : activeTab === "contacts" ? "Contacts" : activeTab === "settings" ? "Réglages" : "Conversations";
  const lineOptions = lines.filter((item) => item.lines);

  return <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
    <aside className="sidebar">
      <div className="sidebar-brand-row"><a className="brand" href="#" onClick={(event) => { event.preventDefault(); setActiveTab("conversations"); }} aria-label="Onoff, conversations"><span className="brand-mark">o</span><span>onoff</span></a><button className="icon-button sidebar-toggle" aria-label={sidebarCollapsed ? "Développer la navigation" : "Réduire la navigation"} aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed(value => !value)}><SidebarSimple size={19}/></button></div>
      <div className="workspace-switch"><span className="workspace-initial">{organizationName.slice(0, 1)}</span>{organizations.length > 1 ? <select aria-label="Organisation active" value={selectedOrg} disabled={voiceState !== "idle" || powerDialerLocked || busy || conversationLocked} onChange={(event) => selectOrganization(event.target.value)}>{organizations.map((item) => <option key={item.organization_id} value={item.organization_id}>{item.organizations?.name ?? "Mon espace"}</option>)}</select> : <span>{organizationName}</span>}</div>
      <span className="nav-label">Espace de travail</span>
      <nav className="main-nav" aria-label="Navigation principale">
        <button className={`nav-item${activeTab === "conversations" ? " selected" : ""}`} aria-current={activeTab === "conversations" ? "page" : undefined} onClick={() => setActiveTab("conversations")} aria-label="Conversations" title="Conversations"><ChatCircle size={20} /><span>Conversations</span>{unreadCount > 0 && <span className="nav-count">{unreadCount}</span>}</button>
        <button className={`nav-item${activeTab === "contacts" ? " selected" : ""}`} aria-current={activeTab === "contacts" ? "page" : undefined} onClick={() => setActiveTab("contacts")} aria-label="Contacts" title="Contacts"><Users size={20} /><span>Contacts</span></button>
        <button className={`nav-item${activeTab === "followups" ? " selected" : ""}`} aria-current={activeTab === "followups" ? "page" : undefined} onClick={() => setActiveTab("followups")} aria-label="Tickets & deals" title="Tickets & deals"><Plus size={20} /><span>Tickets & deals</span></button>
        <button className={`nav-item${activeTab === "powerdialer" ? " selected" : ""}`} aria-current={activeTab === "powerdialer" ? "page" : undefined} onClick={() => setActiveTab("powerdialer")} aria-label="Powerdialer" title="Powerdialer"><Lightning size={20} /><span>Powerdialer</span></button>
        {canPurchaseNumber && <button className={`nav-item${activeTab === "center" ? " selected" : ""}`} aria-current={activeTab === "center" ? "page" : undefined} onClick={() => setActiveTab("center")} aria-label="IVR & files d’attente" title="IVR & files d’attente"><Headset size={20}/><span>IVR & files d’attente</span></button>}
        {canPurchaseNumber && <button className={`nav-item statistics-nav-item${activeTab === "statistics" ? " selected" : ""}`} aria-current={activeTab === "statistics" ? "page" : undefined} onClick={() => setActiveTab("statistics")} aria-label="Statistiques" title="Statistiques"><ChartBar size={20}/><span>Statistiques</span></button>}
        {canPurchaseNumber && <button className={`nav-item admin-nav-item${activeTab === "admin" ? " selected" : ""}`} aria-current={activeTab === "admin" ? "page" : undefined} onClick={() => setActiveTab("admin")} aria-label="Administration" title="Administration"><ShieldCheck size={20} /><span>Administration</span></button>}
        <button className={`nav-item mobile-settings${activeTab === "settings" ? " selected" : ""}`} aria-current={activeTab === "settings" ? "page" : undefined} onClick={() => setActiveTab("settings")} aria-label="Réglages" title="Réglages"><GearSix size={20} /><span>Réglages</span></button>
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-line"><span className="side-label">VOTRE LIGNE</span>{lineOptions.length > 1 ? <select aria-label="Ligne active" value={activeLine?.id ?? ""} disabled={voiceState !== "idle" || powerDialerLocked || busy || conversationLocked} onChange={(event) => selectLine(event.target.value)}>{lineOptions.map((item) => <option key={item.lines!.id} value={item.lines!.id}>{formatPhone(item.lines!.phone_number)}</option>)}</select> : <strong>{activeLine ? formatPhone(activeLine.phone_number) : "Aucune ligne attribuée"}</strong>}<span className="line-availability"><i className={voiceTabOwner && voiceRegisteredRef.current ? "available" : ""} />{voiceTabOwner && voiceRegisteredRef.current ? "Disponible pour les appels" : activeLine ? voiceStatus : "Ajoutez une ligne pour commencer"}</span>{canPurchaseNumber && <button className="text-button" disabled={!canBuy || conversationLocked || powerDialerLocked || busy || voiceState !== "idle"} onClick={() => setNumberPurchaseOpen(true)}><Plus size={14} />Ajouter une ligne</button>}</div>
        <button className={`nav-item${activeTab === "settings" ? " selected" : ""}`} aria-current={activeTab === "settings" ? "page" : undefined} onClick={() => setActiveTab("settings")} aria-label="Réglages" title="Réglages"><GearSix size={20} /><span>Réglages</span></button>
        <button className="profile-button" onClick={() => setActiveTab("settings")} aria-label="Réglages" title="Réglages"><Avatar name={session.user.email ?? "Moi"} /><span><b>{session.user.email?.split("@")[0] ?? "Mon compte"}</b><small>{canPurchaseNumber ? "Administrateur" : "Membre de l’équipe"}</small></span></button>
      </div>
    </aside>

    <main className="main-area">
      <DeferredContent fallback={null}>{selectedOrg && services?.administrationEnabled && <QueuePresence key={`presence:${session.user.id}:${selectedOrg}`} organizationId={selectedOrg} api={api}/>}</DeferredContent>
      <header className="topbar"><div className="topbar-title"><span>{organizationName}</span><span className="breadcrumb-slash" aria-hidden="true">/</span><h1>{sectionTitle}</h1></div><div className="topbar-actions">{voiceState === "active" && providerCallSid && <button className="button button-secondary" onClick={() => setTranscriptTarget({ providerCallSid })}><TextAlignLeft size={17} />Transcription</button>}<button className="icon-button" aria-label="Actualiser l’espace" title="Actualiser" disabled={workspaceState === "loading"} onClick={() => { setAdminRefresh((value) => value + 1); void retryWorkspace(); }}><ArrowClockwise size={18} /></button><button className="button button-secondary" disabled={voiceState === "idle" && !incomingFrom && (!canCall || busy || powerDialerLocked)} onClick={() => openCall()}><Phone size={17} /><span>{voiceState !== "idle" || incomingFrom ? "Appel en cours" : "Nouvel appel"}</span></button></div></header>
      <div className="mobile-line-switch"><label>Votre ligne<select aria-label="Ligne active sur mobile" value={activeLine?.id ?? ""} disabled={voiceState !== "idle" || powerDialerLocked || busy || conversationLocked || !lineOptions.length} onChange={(event) => selectLine(event.target.value)}>{lineOptions.length ? lineOptions.map((item) => <option key={item.lines!.id} value={item.lines!.id}>{formatPhone(item.lines!.phone_number)}</option>) : <option value="">Aucune ligne attribuée</option>}</select></label></div>
      {services && (!services.voiceEnabled || !services.smsEnabled || services.operationsPaused || !services.administrationEnabled) && <div className="app-banner warning" role="status"><WarningCircle size={18}/><span>{services.operationsPaused ? services.pauseMessage : [!services.voiceEnabled && "Appels désactivés.", !services.smsEnabled && "SMS désactivés.", !services.administrationEnabled && "Administration non configurée."].filter(Boolean).join(" ")} {canPurchaseNumber && "La configuration serveur doit être terminée pour activer ces services."}</span></div>}
      {!networkOnline && <div className="app-banner warning" role="status"><WarningCircle size={18} /><span>Vous êtes hors ligne. Reconnectez-vous pour retrouver vos échanges.</span></div>}
      {notice && <div className="app-banner" role="status"><ChatCircle size={18} /><span>{notice}</span><button className="icon-button" aria-label="Fermer le message" onClick={() => setNotice("")}><X size={16} /></button></div>}
      {smsRecoveryState === "unavailable" && <div className="app-banner warning" role="alert"><WarningCircle size={18} /><span>Impossible de vérifier les SMS précédents.</span><button className="text-button" onClick={() => void retrySmsRecovery()}>Réessayer</button></div>}
      {!activeLine && workspaceState === "ready" && <div className="app-banner"><Phone size={18} /><span>{canPurchaseNumber ? "Ajoutez votre première ligne pour commencer à échanger." : "Demandez à votre administrateur de vous attribuer une ligne."}</span>{canPurchaseNumber && <button className="text-button" disabled={!canBuy} onClick={() => setNumberPurchaseOpen(true)}>Ajouter une ligne</button>}</div>}

      <PowerDialer key={`${session.user.id}:${selectedOrg}:${activeLine?.id ?? ""}`} visible={activeTab === "powerdialer"}
        scope={{ userId: session.user.id, organizationId: selectedOrg, lineId: activeLine?.id ?? "" }}
        lineNumber={activeLine?.phone_number ?? ""} enabled={canCall && networkOnline}
        blocked={Boolean(incomingFrom) || dialerOpen || numberPurchaseOpen || newConversationOpen || contactEditorOpen}
        voiceStatus={voiceStatus} voiceState={voiceState} muted={muted} calls={calls}
        loadContacts={(query, cursor) => api(`/v1/organizations/${selectedOrg}/contacts?limit=50${query ? `&q=${encodeURIComponent(query)}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)}
        onStart={(number, shouldContinue) => startVoiceCall(number, shouldContinue, true)} onHangup={() => voiceClient.current?.hangUp()} onMute={() => voiceClient.current?.setMuted(!muted)} onDigits={(digits) => voiceClient.current?.sendDigits(digits)}
        subscribe={subscribePowerDialer} onLock={setPowerDialerLocked} api={api} onContactSaved={() => { void directory.refresh(); }}
      />
      <DeferredContent key={activeTab} fallback={<p role="status">Chargement de la rubrique…</p>}>
      {activeTab === "followups" ? (selectedOrg ? <CallFollowups key={`${session.user.id}:${selectedOrg}`} organizationId={selectedOrg} api={api} onCall={callId => setTranscriptTarget({ callId })} /> : <EmptyState icon={<Plus size={26} />} title="Aucun espace sélectionné" />) : activeTab === "statistics" ? (canPurchaseNumber && selectedOrg ? <Statistics key={`${session.user.id}:${selectedOrg}`} organizationId={selectedOrg} api={api} refreshKey={adminRefresh}/> : <EmptyState icon={<ChartBar/>} title="Accès administrateur requis"/>) : activeTab === "powerdialer" ? null : activeTab === "conversations" ? <Conversations
        inbox={inbox} contacts={contacts} number={messageDestination} lineNumber={activeLine?.phone_number ?? ""}
        messages={conversationMessages} body={messageBody} dataState={workspaceState} messagesState={messagesState}
        busy={busy || !networkOnline || smsRecoveryState !== "ready"} locked={conversationLocked} pending={Boolean(pendingSmsAttempt)}
        canSms={canSms} smsUnavailable={smsUnavailable} canCall={canCall && !powerDialerLocked && !busy && voiceState === "idle"} segments={smsSegmentInfo.segments}
        hasMore={Boolean(historyCursors.calls || historyCursors.conversations)} hasOlderMessages={Boolean(messagesCursor)} loadingMore={loadingMore}
        onMore={() => void loadMoreHistory()} onOlderMessages={() => void loadOlderMessages()}
        onOpen={openConversation} onNew={() => setNewConversationOpen(true)}
        onBack={() => { drafts.current[`${selectedLineId}:${phoneKey(messageDestination)}`] = messageBody; setMessageDestination(""); setSelectedConversationId(""); setMessageBody(""); }}
        onTranscript={(callId) => setTranscriptTarget({ callId })} onBody={setMessageBody} onSend={sendMessage} onCall={openCall} onAddContact={newContact} onRetry={() => void retryWorkspace()}
      /> : activeTab === "center" ? (canPurchaseNumber && selectedOrg ? <CallCenter key={`${session.user.id}:${selectedOrg}`} organizationId={selectedOrg} api={api} refreshKey={adminRefresh} audio={async path => { const response = await fetch(`${apiBase}${path}`, { headers: { authorization: `Bearer ${authToken}` } }); if (!response.ok) throw new Error("L’enregistrement est indisponible."); return response.blob(); }} /> : <EmptyState icon={<Headset/>} title="Accès administrateur requis"/>) : activeTab === "contacts" ? <Contacts contacts={contacts} search={contactSearch} busy={busy || !networkOnline || !selectedOrg} canCall={canCall && !powerDialerLocked && voiceState === "idle"} canSms={canSms && !conversationLocked} dataState={directory.state} error={directory.error} hasMore={directory.hasMore} loadingMore={directory.loadingMore} onMore={() => void directory.more()} onRetry={() => void directory.refresh()} onSearch={setContactSearch} onAdd={() => newContact()} onEdit={beginEditContact} onArchive={(contact) => void archiveContact(contact)} onCall={(contact) => openCall(contact.contact_phones[0]?.phone_number)} onMessage={(contact) => openConversation(contact.contact_phones[0]?.phone_number ?? "")} /> : activeTab === "admin" ? (canPurchaseNumber && selectedOrg ? <Admin key={`${session.user.id}:${selectedOrg}`} organizationId={selectedOrg} userId={session.user.id} api={api} refreshKey={adminRefresh} purchaseEnabled={canBuy} onPurchase={() => setNumberPurchaseOpen(true)} onChanged={async () => { const result = await api<{ items: Organization[] }>("/v1/organizations"); setOrganizations(result.items); if (!result.items.some((item) => item.organization_id === selectedOrg && item.role === "admin")) setActiveTab("settings"); await refreshWorkspace(selectedOrg); }} /> : <EmptyState icon={<ShieldCheck size={26} />} title="Accès administrateur requis"><p>Choisissez un espace dans lequel vous êtes administrateur.</p></EmptyState>) : <Settings
        key={`settings:${session.user.id}:${selectedOrg}`}
        api={api}
        email={session.user.email}
        organizationId={selectedOrg}
        organizationName={organizationName}
        lines={lineOptions}
        activeLineId={activeLine?.id}
        devices={activeDevices}
        services={services}
        isAdmin={canPurchaseNumber}
        voiceStatus={voiceStatus}
        canReconnect={Boolean(services?.voiceEnabled && activeLine?.voice_enabled && activeAssignment?.can_voice)}
        disabledActions={{
          signOut: Boolean(pendingSmsAttempt) || powerDialerLocked || busy || voiceState !== "idle",
          lines: conversationLocked || powerDialerLocked || busy || voiceState !== "idle",
          purchase: !canBuy || conversationLocked || powerDialerLocked || busy || voiceState !== "idle",
          devices: busy || powerDialerLocked || voiceState !== "idle",
          reconnect: busy || voiceState !== "idle" || powerDialerLocked || !networkOnline,
        }}
        onSignOut={() => void signOut()}
        onPurchase={() => setNumberPurchaseOpen(true)}
        onSelectLine={selectLine}
        onRevokeDevice={(id) => void revokeDevice(id)}
        onReconnect={() => setVoiceRetry((value) => value + 1)}
      />}
      </DeferredContent>
    </main>

    {(voiceState !== "idle" || incomingFrom) && !dialerOpen && !(powerDialerLocked && activeTab === "powerdialer") && <button className="active-call-bar" onClick={() => powerDialerLocked ? setActiveTab("powerdialer") : setDialerOpen(true)}><Phone size={19} /><span>{incomingFrom ? "Appel entrant" : voiceStatus}</span><ArrowRight size={17} /></button>}
    {newConversationOpen && <NewConversation scope={`${session.user.id}:${selectedOrg}`} loadContacts={(query, cursor, signal) => apiClient.getPage<Contact>(`/v1/organizations/${selectedOrg}/contacts`, { limit: 50, cursor, query: { q: query || undefined }, signal })} onClose={() => setNewConversationOpen(false)} onOpen={(number) => openConversation(number)} />}
    {transcriptTarget && <Modal title="Tags & transcription de l’appel" className="transcript-modal" onClose={() => setTranscriptTarget(null)}><CallTranscript key={`${session.user.id}:${selectedOrg}:${transcriptTarget.callId ?? transcriptTarget.providerCallSid}`} api={api} loadAudio={loadCallAudio} playbackBlocked={voiceState !== "idle"} target={transcriptTarget} /></Modal>}
    {dialerOpen && <CallDialog ended={callEnded} actions={callContext && selectedOrg ? <CallCreateActions key={`${selectedOrg}:${callContext.key}`} organizationId={selectedOrg} context={callContext} api={api} disabled={!networkOnline} onContactSaved={() => { void directory.refresh(); }} /> : null} transcript={(voiceState === "active" || callEnded) && providerCallSid ? <CallTranscript key={providerCallSid} api={api} loadAudio={loadCallAudio} playbackBlocked={voiceState !== "idle"} target={{ providerCallSid }} remoteName={destinationContact?.display_name ?? "Interlocuteur"} /> : null} number={destination} name={destinationContact?.display_name ?? null} line={activeLine?.phone_number ?? "non attribuée"} status={voiceStatus} state={voiceState} incoming={incomingFrom} muted={muted} enabled={canCall} busy={busy} onNumber={setDestination} onClose={() => setDialerOpen(false)} onCall={() => void startVoiceCall().catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Appel impossible."))} onAccept={() => voiceClient.current?.acceptCall()} onReject={() => voiceClient.current?.rejectCall()} onHangup={() => voiceClient.current?.hangUp()} onMute={() => voiceClient.current?.setMuted(!muted)} onDigit={(digit) => voiceClient.current?.sendDigits(digit)} />}
    {contactEditorOpen && <Modal title={editingContact ? "Modifier le contact" : "Ajouter un contact"} onClose={() => setContactEditorOpen(false)} busy={busy}><form className="contact-form" onSubmit={createContact}><label className="field-label">Nom du contact<input autoFocus value={contactName} onChange={(event) => setContactName(event.target.value)} placeholder="Prénom Nom" required maxLength={120} /></label><label className="field-label">Téléphone<input inputMode="tel" value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} placeholder="+33 6 12 34 56 78" /></label>{duplicateContact && <p className="inline-warning" role="status">Ce numéro est déjà associé à {duplicateContact.display_name}.</p>}{editingContact && editingContact.contact_phones.length > 1 && <p className="form-note">Autres numéros conservés : {editingContact.contact_phones.slice(1).map(phone => formatPhone(phone.phone_number)).join(", ")}</p>}<label className="field-label">Email <span className="optional-label">(facultatif)</span><input type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} placeholder="nom@entreprise.com" /></label>{contactFormError && <p className="form-error" role="alert">{contactFormError}</p>}<div className="modal-actions"><button className="button button-secondary" type="button" disabled={busy} onClick={() => setContactEditorOpen(false)}>Annuler</button><button className="button button-primary" disabled={busy}>{busy ? "Enregistrement…" : "Enregistrer"}</button></div></form></Modal>}
    <DeferredContent key={String(numberPurchaseOpen)} onClose={() => setNumberPurchaseOpen(false)} fallback={<p role="status">Chargement des numéros…</p>}>{numberPurchaseOpen && selectedOrg && <NumberPurchase key={`${session.user.id}:${selectedOrg}`} organizationId={selectedOrg} userId={session.user.id} email={session.user.email ?? "votre compte"} api={api} onClose={() => setNumberPurchaseOpen(false)} onPurchased={async (lineId) => { await refreshWorkspace(selectedOrg); setSelectedLineId(lineId); setMessageDestination(""); setSelectedConversationId(""); setMessageBody(""); if (activeTab === "admin") { setAdminRefresh((value) => value + 1); } else { setActiveTab("conversations"); setDialerOpen(true); } setNumberPurchaseOpen(false); setNotice("Votre nouvelle ligne est prête."); }} />}</DeferredContent>
  </div>;
}
