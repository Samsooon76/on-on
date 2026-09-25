import { createClient, type Session } from "@supabase/supabase-js";
import { useEffect, useMemo, useRef, useState } from "react";
import webPackage from "../package.json";
import { normalizePhoneNumber } from "@onoff/contracts";
import { ApiClientError, createApiClient, getSmsSegmentInfo } from "@onoff/api-client";
import { createVoiceClient, type VoiceEvent } from "@onoff/voice-web";
import type { VoiceClient } from "@onoff/voice-contract";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4100";
const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;

type Organization = { organization_id: string; role: "admin" | "member"; organizations: { id: string; name: string } | null };
type LineAssignment = { can_voice: boolean; can_sms: boolean; lines: { id: string; phone_number: string; voice_enabled: boolean; sms_enabled: boolean } | null };
type Contact = { id: string; display_name: string; email: string | null; version: number; contact_phones: { id: string; phone_number: string; label: string }[] };
type CallRecord = { id: string; direction: "inbound" | "outbound"; remote_number: string; remoteContactName: string | null; status: string; created_at: string; duration_seconds: number | null };
type Conversation = { id: string; lineId: string; remoteNumber: string; remoteContactName: string | null; lastMessageAt: string | null; lastMessage: { id: string; body: string; direction: string; status: string; created_at: string } | null; unread: boolean };
type MessageRecord = { id: string; direction: "inbound" | "outbound"; body: string; status: string; provider_error_code: string | null; created_at: string; sent_at: string | null; delivered_at: string | null };
type DeviceRecord = { id: string; organization_id: string; platform: string; label: string; status: string; last_active_at: string | null; created_at: string };
type VoiceDiagnosticEvent = "voice_registration_failed" | "history_refresh_succeeded" | "history_refresh_failed";

function takeCallDraftFromUrl(): string {
  const url = new URL(window.location.href);
  const value = url.searchParams.get("callTo");
  if (value === null) return "";
  url.searchParams.delete("callTo");
  window.history.replaceState(window.history.state, "", url);
  return normalizePhoneNumber(value) ?? "";
}

function ContactPanel(props: {
  contacts: Contact[];
  dataState: "loading" | "ready" | "error";
  busy: boolean;
  search: string;
  editing: Contact | null;
  name: string;
  email: string;
  phone: string;
  onSearch(value: string): void;
  onName(value: string): void;
  onEmail(value: string): void;
  onPhone(value: string): void;
  onSubmit(event: React.FormEvent): void;
  onCancel(): void;
  onEdit(contact: Contact): void;
  onArchive(contact: Contact): void;
  onCall(contact: Contact): void;
  onMessage(contact: Contact): void;
}) {
  const normalizedPhone = normalizePhoneNumber(props.phone);
  const duplicate = normalizedPhone
    ? props.contacts.find((contact) => contact.id !== props.editing?.id && contact.contact_phones.some((phone) => phone.phone_number === normalizedPhone))
    : undefined;
  return (
    <section className="content-card contacts-card">
      <div className="section-heading"><div><span className="eyebrow">CARNET PARTAGÉ</span><h2>Répertoire</h2></div><span className="subtle-count">{props.contacts.length} contact{props.contacts.length === 1 ? "" : "s"}</span></div>
      <form className="contact-form" onSubmit={props.onSubmit}>
        <input aria-label="Nom du contact" value={props.name} onChange={(event) => props.onName(event.target.value)} placeholder="Nom du contact" required maxLength={120} />
        <input aria-label="Téléphone" inputMode="tel" value={props.phone} onChange={(event) => props.onPhone(event.target.value)} placeholder="+32 470 00 00 00" />
        {duplicate && <p className="duplicate-contact-warning" role="status">Ce numéro figure déjà chez {duplicate.display_name}. Vérifiez avant d’enregistrer; les contacts existants ne seront pas fusionnés.</p>}
        <input aria-label="Email" type="email" value={props.email} onChange={(event) => props.onEmail(event.target.value)} placeholder="Email (facultatif)" />
        <button className="button button-primary" disabled={props.busy}>{props.busy ? "Enregistrement…" : props.editing ? "Enregistrer" : "Ajouter"}<span>{props.editing ? "✓" : "+"}</span></button>
        {props.editing && <button type="button" className="button contact-cancel" onClick={props.onCancel}>Annuler</button>}
      </form>
      <label className="contact-search">Rechercher<input type="search" value={props.search} onChange={(event) => props.onSearch(event.target.value)} placeholder="Nom du contact" maxLength={80} /></label>
      <div className="contact-list">{props.contacts.length ? props.contacts.map((contact) => (
        <div className="contact-row" key={contact.id}>
          <div className="contact-avatar">{contact.display_name.slice(0, 1).toUpperCase()}</div>
          <div className="contact-detail"><b>{contact.display_name}</b><small>{contact.contact_phones[0]?.phone_number ?? contact.email ?? "Aucun numéro"}</small></div>
          <div className="contact-actions">
            <button className="contact-call" disabled={!contact.contact_phones[0]?.phone_number} onClick={() => props.onCall(contact)} aria-label={`Appeler ${contact.display_name}`}>⌕</button>
            <button className="contact-call" disabled={!contact.contact_phones[0]?.phone_number} onClick={() => props.onMessage(contact)} aria-label={`Écrire à ${contact.display_name}`}>▤</button>
            <button className="contact-call" onClick={() => props.onEdit(contact)} aria-label={`Modifier ${contact.display_name}`}>✎</button>
            <button className="contact-call contact-archive" disabled={props.busy} onClick={() => props.onArchive(contact)} aria-label={`Archiver ${contact.display_name}`}>⌫</button>
          </div>
        </div>
      )) : <div className="empty-state" role={props.dataState === "loading" ? "status" : undefined}><span className="empty-icon" aria-hidden="true">♙</span><b>{props.dataState === "loading" ? "Chargement des contacts…" : props.dataState === "error" ? "Contacts indisponibles" : props.search ? "Aucun résultat" : "Votre carnet est prêt"}</b><p>{props.dataState === "loading" ? "Récupération du carnet partagé." : props.dataState === "error" ? "Vérifiez la connexion puis actualisez l’espace." : props.search ? "Essayez un autre nom." : "Ajoutez le premier contact pour le partager avec votre équipe."}</p></div>}</div>
    </section>
  );
}

export default function App() {
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
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactSearch, setContactSearch] = useState("");
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [destination, setDestination] = useState(takeCallDraftFromUrl);
  const [notice, setNotice] = useState("");
  const [activeTab, setActiveTab] = useState<"activity" | "contacts" | "messages" | "settings">("activity");
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [conversationMessages, setConversationMessages] = useState<MessageRecord[]>([]);
  const [messageDestination, setMessageDestination] = useState("");
  const [messageBody, setMessageBody] = useState("");
  const [pendingSmsAttempt, setPendingSmsAttempt] = useState<{ signature: string; key: string } | null>(null);
  const [smsRecoveryState, setSmsRecoveryState] = useState<"checking" | "ready" | "unavailable">("checking");
  const [voiceStatus, setVoiceStatus] = useState("Ligne inactive");
  const [voiceTabOwner, setVoiceTabOwner] = useState(false);
  const [voiceState, setVoiceState] = useState<"idle" | "connecting" | "ringing" | "active">("idle");
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
  const selectedConversationContactName = conversations.find((conversation) => conversation.id === selectedConversationId)?.remoteContactName ?? null;
  const normalizedDestination = normalizePhoneNumber(destination);
  const destinationContact = normalizedDestination
    ? contacts.find((contact) => contact.contact_phones.some((phone) => phone.phone_number === normalizedDestination)) ?? null
    : null;

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      const nextUserId = nextSession?.user.id ?? "";
      if (currentUserId.current && currentUserId.current !== nextUserId) {
        voiceOwnershipRelease.current?.();
        voiceOwnershipRelease.current = null;
        setVoiceTabOwner(false);
        setVoiceState("idle");
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
        setContacts([]);
        setDevices([]);
        setCalls([]);
        setConversations([]);
        setSelectedConversationId("");
        setConversationMessages([]);
        setPendingSmsAttempt(null);
        setSmsRecoveryState("checking");
      }
      currentUserId.current = nextUserId;
      setSession(nextSession);
      if (event === "PASSWORD_RECOVERY") setPasswordRecovery(true);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => () => {
    voiceUnsubscribe.current?.();
    void voiceClient.current?.destroy();
    voiceClient.current = null;
  }, []);

  const authToken = session?.access_token;
  const apiClient = useMemo(() => createApiClient({ baseUrl: apiBase, getAccessToken: () => authToken }), [authToken]);
  const activeAssignment = useMemo(() => lines.find((item) => item.lines?.id === selectedLineId) ?? lines.find((item) => item.lines) ?? null, [lines, selectedLineId]);
  const activeLine = activeAssignment?.lines ?? null;
  const todayLabel = new Intl.DateTimeFormat("fr-BE", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    return apiClient.request<T>(path, init);
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
    if (voiceState !== "idle") {
      setNotice("Terminez l’appel avant de changer d’organisation.");
      return;
    }
    if (organizationId === selectedOrg) return;
    setLines([]);
    setSelectedLineId("");
    setContacts([]);
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
    if (voiceState !== "idle") {
      setNotice("Terminez l’appel avant de changer de ligne.");
      return;
    }
    if (lineId === selectedLineId) return;
    setCalls([]);
    setConversations([]);
    setSelectedConversationId("");
    setConversationMessages([]);
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

  async function refreshWorkspace(orgId = selectedOrg) {
    if (!orgId) return;
    const [lineResponse, contactResponse, deviceResponse] = await Promise.all([
      api<{ items: LineAssignment[] }>(`/v1/organizations/${orgId}/lines`),
      api<{ items: Contact[] }>(`/v1/organizations/${orgId}/contacts?limit=50${contactSearch ? `&q=${encodeURIComponent(contactSearch)}` : ""}`),
      api<{ items: DeviceRecord[] }>("/v1/devices"),
    ]);
    setLines(lineResponse.items);
    setContacts(contactResponse.items);
    setDevices(deviceResponse.items);
    const assignment = lineResponse.items.find((item) => item.lines?.id === selectedLineId) ?? lineResponse.items.find((item) => item.lines);
    const line = assignment?.lines;
    setSelectedLineId(line?.id ?? "");
    if (line) {
      const [callResponse, conversationResponse] = await Promise.all([
        api<{ items: CallRecord[] }>(`/v1/lines/${line.id}/calls?limit=20`),
        api<{ items: Conversation[] }>(`/v1/lines/${line.id}/conversations?limit=50`),
      ]);
      setCalls(callResponse.items);
      setConversations(conversationResponse.items);
      if (!conversationResponse.items.some((item) => item.id === selectedConversationId)) {
        setSelectedConversationId(conversationResponse.items[0]?.id ?? "");
      }
    } else {
      setCalls([]);
      setConversations([]);
      setSelectedConversationId("");
      setSelectedLineId("");
    }
  }

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
    await refreshWorkspace(pending.organization_id);
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

  useEffect(() => {
    if (!authToken) {
      setWorkspaceState("ready");
      setSmsRecoveryState("checking");
      setPendingSmsAttempt(null);
      setOrganizations([]);
      setLines([]);
      setContacts([]);
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
    void api<{ items: Organization[] }>("/v1/organizations")
      .then(async ({ items }) => {
        if (disposed) return;
        setOrganizations(items);
        const next = selectedOrg && items.some((item) => item.organization_id === selectedOrg)
          ? selectedOrg
          : items[0]?.organization_id ?? "";
        setSelectedOrg(next);
        if (next) await refreshWorkspace(next);
        await restorePendingSmsAttempt(() => !disposed);
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
    setWorkspaceState("loading");
    void refreshWorkspace(selectedOrg)
      .then(() => setWorkspaceState("ready"))
      .catch((error: Error) => { setWorkspaceState("error"); setNotice(error.message); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrg]);

  useEffect(() => {
    if (!selectedOrg || !authToken) return;
    const timer = window.setTimeout(() => {
      void api<{ items: Contact[] }>(`/v1/organizations/${selectedOrg}/contacts?limit=50${contactSearch ? `&q=${encodeURIComponent(contactSearch)}` : ""}`)
        .then(({ items }) => setContacts(items))
        .catch((error: Error) => setNotice(error.message));
    }, 250);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrg, authToken, contactSearch]);

  useEffect(() => {
    if (!selectedOrg || !selectedLineId || !authToken) return;
    setWorkspaceState("loading");
    void refreshWorkspace(selectedOrg)
      .then(() => setWorkspaceState("ready"))
      .catch((error: Error) => { setWorkspaceState("error"); setNotice(error.message); });
  // refreshWorkspace reads the current bearer token and selected line.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLineId]);

  useEffect(() => {
    if (!selectedConversationId || !authToken) {
      setConversationMessages([]);
      return;
    }
    if (activeTab !== "messages") return;
    let disposed = false;
    void api<{ items: MessageRecord[] }>(`/v1/conversations/${selectedConversationId}/messages?limit=50`)
      .then(async ({ items }) => {
        if (disposed) return;
        setConversationMessages(items);
        await api(`/v1/conversations/${selectedConversationId}/read`, {
          method: "PUT",
          body: JSON.stringify({ lastReadMessageId: items.at(-1)?.id ?? null }),
        });
        if (!disposed) setConversations((current) => current.map((conversation) => conversation.id === selectedConversationId ? { ...conversation, unread: false } : conversation));
      })
      .catch((error: Error) => { if (!disposed) setNotice(error.message); });
    return () => { disposed = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken, selectedConversationId, activeTab]);

  useEffect(() => {
    if (!supabase || !authToken || !selectedOrg) return;
    let disposed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const channels: Array<ReturnType<typeof supabase.channel>> = [];
    const refresh = () => {
      if (disposed || refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refreshWorkspace(selectedOrg).catch((error: Error) => setNotice(error.message));
      }, 150);
    };
    const refreshFromEvent = (payload: unknown) => {
      if (disposed || !payload || typeof payload !== "object") return;
      const kind = (payload as { kind?: unknown }).kind;
      const reportError = (error: Error) => { if (!disposed) setNotice(error.message); };
      if (kind === "contact") {
        void api<{ items: Contact[] }>(`/v1/organizations/${selectedOrg}/contacts?limit=50${contactSearch ? `&q=${encodeURIComponent(contactSearch)}` : ""}`)
          .then(({ items }) => { if (!disposed) setContacts(items); }).catch(reportError);
      } else if (kind === "device") {
        void api<{ items: DeviceRecord[] }>("/v1/devices")
          .then(({ items }) => { if (!disposed) setDevices(items); }).catch(reportError);
      } else if (kind === "call" && activeLine?.id) {
        void api<{ items: CallRecord[] }>(`/v1/lines/${activeLine.id}/calls?limit=20`)
          .then(({ items }) => { if (!disposed) setCalls(items); }).catch(reportError);
      } else if (kind === "message" && activeLine?.id) {
        void api<{ items: Conversation[] }>(`/v1/lines/${activeLine.id}/conversations?limit=50`)
          .then(({ items }) => { if (!disposed) setConversations(items); }).catch(reportError);
        const conversationId = selectedConversationIdRef.current;
        if (conversationId) {
          void api<{ items: MessageRecord[] }>(`/v1/conversations/${conversationId}/messages?limit=50`)
            .then(async ({ items }) => {
              if (disposed) return;
              setConversationMessages(items);
              if (activeTabRef.current === "messages") {
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
    void supabase.realtime.setAuth(authToken).then(() => {
      if (disposed) return;
      for (const topic of topics) {
        const channel = supabase.channel(topic, { config: { private: true } })
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
      for (const channel of channels) void supabase.removeChannel(channel);
    };
  // Invalidation payloads contain IDs/status only; read current state from the API.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken, selectedOrg, activeLine?.id, activeAssignment?.can_voice, activeAssignment?.can_sms, contactSearch, selectedConversationId]);

  useEffect(() => {
    if (!authToken || !selectedOrg) return;
    const refreshWhenVisible = () => {
      if (navigator.onLine && document.visibilityState === "visible") {
        void refreshWorkspace(selectedOrg).catch((error: Error) => setNotice(error.message));
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
  }, [authToken, selectedOrg]);

  useEffect(() => {
    if (!authToken || !selectedOrg || !activeLine?.id || !activeLine.voice_enabled || !activeAssignment?.can_voice) {
      setVoiceTabOwner(false);
      void shutdownVoiceClient();
      if (!authToken) deviceRef.current = null;
      setVoiceStatus("Ligne inactive");
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
  }, [authToken, selectedOrg, activeLine?.id, activeLine?.voice_enabled, activeAssignment?.can_voice, session?.user.id]);

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
    try {
      if (!supabase || !email.trim()) throw new Error("Saisissez d’abord votre adresse email.");
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
      if (error) throw error;
      setAuthError("Un lien de réinitialisation a été envoyé si cette adresse possède un compte.");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Le lien de réinitialisation n’a pas pu être envoyé.");
    }
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
      setNotice("Saisissez un numéro international ou un numéro français à 10 chiffres.");
      return;
    }
    setBusy(true);
    try {
      const payload = JSON.stringify({ displayName: contactName.trim(), email: contactEmail.trim() || null, phones: phone ? [{ phoneNumber: phone, label: "Mobile" }] : [] });
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
      await refreshWorkspace();
      setNotice(wasEditing ? "Contact modifié." : "Contact ajouté au carnet partagé.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Le contact n'a pas pu être ajouté.");
    } finally {
      setBusy(false);
    }
  }

  function beginEditContact(contact: Contact) {
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
      await refreshWorkspace();
      setNotice("Contact archivé.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Le contact n’a pas pu être archivé.");
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (smsRecoveryState !== "ready") {
      setNotice("Les envois SMS précédents doivent être vérifiés avant un nouvel envoi.");
      return;
    }
    if (!selectedOrg || !activeLine || !activeAssignment?.can_sms || !activeLine.sms_enabled) return;
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
        setNotice(result.status === "submitting" ? "Twilio a accepté le message; la remise est en attente." : "Message envoyé à Twilio.");
    }
    try {
      await refreshWorkspace();
      const messages = await api<{ items: MessageRecord[] }>(`/v1/conversations/${result.conversationId}/messages?limit=50`);
      setConversationMessages(messages.items);
    } catch { /* Keep the send result visible; the next refresh will reload persisted data. */ }
    setBusy(false);
  }

  function handleVoiceEvent(event: VoiceEvent) {
    switch (event.type) {
      case "ready": void setVoiceRegistration(true); setVoiceStatus("Prête à appeler"); break;
      case "unavailable": void setVoiceRegistration(false); setVoiceStatus(event.message); setNotice(event.message); break;
      case "incoming": setIncomingFrom(event.from); setVoiceStatus("Appel entrant"); break;
      case "connecting": setVoiceState("connecting"); setVoiceStatus("Connexion en cours…"); break;
      case "ringing": setVoiceState("ringing"); setVoiceStatus("Le destinataire sonne…"); break;
      case "active": setVoiceState("active"); setIncomingFrom(""); setVoiceStatus("En communication"); break;
      case "reconnecting": setVoiceStatus("Reconnexion de l’appel…"); break;
      case "reconnected": setVoiceState("active"); setVoiceStatus("En communication"); break;
      case "ended":
        setVoiceState("idle"); setIncomingFrom(""); setMuted(false);
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

  async function startVoiceCall() {
    if (!voiceTabOwner) {
      setNotice("Les appels sont actifs dans un autre onglet. Fermez-le pour reprendre ici.");
      return;
    }
    if (!selectedOrg || !activeLine || !activeAssignment?.can_voice || !activeLine.voice_enabled) return;
    const normalizedDestination = normalizePhoneNumber(destination);
    if (!normalizedDestination) {
      setNotice("Saisissez un numéro international ou un numéro français à 10 chiffres.");
      return;
    }
    setBusy(true);
    setNotice("");
    let unusedIntentId: string | null = null;
    try {
      await requestMicrophoneAccess();
      await ensureVoiceClient(selectedOrg, activeLine.id);
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
      await client.startCall({ destination: normalizedDestination, intentId: intent.id });
      unusedIntentId = null;
      setDestination(normalizedDestination);
    } catch (error) {
      if (unusedIntentId) {
        try { await api(`/v1/call-intents/${unusedIntentId}/cancel`, { method: "POST" }); } catch { /* The reservation still expires through the server's bounded cleanup. */ }
      }
      setVoiceState("idle");
      setVoiceStatus("Appel impossible");
      setNotice(error instanceof Error ? error.message : "L’appel n’a pas pu démarrer.");
    } finally {
      setBusy(false);
    }
  }

  function callStatus(status: string): string {
    return ({ initiated: "Préparation", ringing: "Sonnerie", answered: "En cours", completed: "Terminé", missed: "Manqué", failed: "Échec", canceled: "Annulé" } as Record<string, string>)[status] ?? status;
  }

  if (!ready) return <div className="boot-screen"><span className="brand-mark">o</span><span>Préparation de votre espace…</span></div>;

  if (!session || passwordRecovery) return (
    <main className="auth-shell">
      <section className="auth-panel">
        <a className="brand" href="#"><span className="brand-mark">o</span><span>onoff</span></a>
        <div className="auth-copy">
          <span className="eyebrow">ESPACE DE TRAVAIL</span>
          <h1>{passwordRecovery ? <>Choisissez un<br /><em>nouveau mot de passe.</em></> : <>Votre ligne.<br /><em>Partout avec vous.</em></>}</h1>
          <p>{passwordRecovery ? "Votre lien a été vérifié. Définissez un nouveau mot de passe." : "Connectez-vous à votre espace téléphonique sécurisé."}</p>
        </div>
        <form className="auth-form" onSubmit={passwordRecovery ? updateRecoveredPassword : signIn}>
          {passwordRecovery ? (
            <label>Nouveau mot de passe<input autoComplete="new-password" type="password" minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required placeholder="8 caractères minimum" /></label>
          ) : (
            <>
              <label>Email professionnel<input autoComplete="username" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="nom@entreprise.com" /></label>
              <label>Mot de passe<input autoComplete="current-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="Votre mot de passe" /></label>
            </>
          )}
          {authError && <p className="form-error" role="status">{authError}</p>}
          {!supabase && <p className="form-note">Renseignez les variables VITE_SUPABASE_URL et VITE_SUPABASE_PUBLISHABLE_KEY pour activer la connexion.</p>}
          <button className="button button-primary button-wide" disabled={busy || !supabase}>{busy ? "Enregistrement…" : passwordRecovery ? "Enregistrer le mot de passe" : "Se connecter"}<span>→</span></button>
          {!passwordRecovery && <button type="button" className="auth-link" disabled={busy || !supabase} onClick={() => void sendPasswordReset()}>Mot de passe oublié ?</button>}
        </form>
        <p className="auth-foot">Accès privé · Comptes créés par un administrateur</p>
      </section>
      <aside className="auth-visual">
        <div className="visual-orbit orbit-one" /><div className="visual-orbit orbit-two" />
        <div className="phone-card"><div className="phone-top"><span>Appel en cours</span><span className="signal"><i /><i /><i /></span></div><div className="phone-avatar">AM</div><strong>Alex Martin</strong><small>+32 470 00 00 00</small><div className="call-wave"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div><div className="call-buttons"><span>⌕</span><span>◉</span><b>⌕</b></div><div className="call-timer">04:32</div></div>
        <div className="visual-caption"><span className="live-dot" /> Tous vos appareils, une seule ligne.</div>
        <div className="visual-grid grid-top" /><div className="visual-grid grid-bottom" />
      </aside>
    </main>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#"><span className="brand-mark">o</span><span>onoff</span></a>
        <div className="workspace-select"><span className="workspace-icon">{(organizations.find((item) => item.organization_id === selectedOrg)?.organizations?.name ?? "O").slice(0, 1).toUpperCase()}</span><span className="workspace-name"><b>{organizations.find((item) => item.organization_id === selectedOrg)?.organizations?.name ?? "Espace"}</b><small>Équipe</small></span>{organizations.length > 1 ? <select className="workspace-select-control" aria-label="Organisation active" value={selectedOrg} disabled={voiceState !== "idle" || Boolean(pendingSmsAttempt) || smsRecoveryState !== "ready"} onChange={(event) => selectOrganization(event.target.value)}>{organizations.map((item) => <option key={item.organization_id} value={item.organization_id}>{item.organizations?.name ?? "Espace"}</option>)}</select> : <span className="chevron">⌄</span>}</div>
        <div className="side-label">ESPACE DE TRAVAIL</div>
        <nav className="main-nav" aria-label="Navigation principale">
          <button aria-current={activeTab === "activity" ? "page" : undefined} className={activeTab === "activity" ? "nav-item selected" : "nav-item"} onClick={() => setActiveTab("activity")}><span className="nav-icon" aria-hidden="true">◷</span>Activité</button>
          <button aria-current={activeTab === "messages" ? "page" : undefined} className={activeTab === "messages" ? "nav-item selected" : "nav-item"} onClick={() => setActiveTab("messages")}><span className="nav-icon" aria-hidden="true">▤</span>Messages<span className="nav-count">{conversations.length}</span></button>
          <button aria-current={activeTab === "contacts" ? "page" : undefined} className={activeTab === "contacts" ? "nav-item selected" : "nav-item"} onClick={() => setActiveTab("contacts")}><span className="nav-icon" aria-hidden="true">♙</span>Contacts</button>
          <button aria-current={activeTab === "settings" ? "page" : undefined} className={activeTab === "settings" ? "nav-item selected" : "nav-item"} onClick={() => setActiveTab("settings")}><span className="nav-icon" aria-hidden="true">⚙</span>Réglages</button>
        </nav>
        <div className="sidebar-bottom"><div className="profile"><div className="profile-avatar">{session.user.email?.slice(0, 1).toUpperCase() ?? "U"}</div><div className="profile-copy"><b>{session.user.email}</b><small>Compte de démonstration</small></div><button aria-label="Se déconnecter" className="logout" onClick={() => void supabase?.auth.signOut()}>↗</button></div></div>
      </aside>
      <main className="main-area">
        <header className="topbar"><div className="breadcrumbs">Espace de travail <span aria-hidden="true">/</span> <b>{activeTab === "contacts" ? "Contacts" : activeTab === "messages" ? "Messages" : activeTab === "settings" ? "Réglages" : "Activité"}</b></div><div className="top-actions"><div className="status-pill" role="status" aria-live="polite"><i aria-hidden="true" /> {voiceStatus}</div><button type="button" className="icon-button" aria-label="Notifications, non disponible dans ce prototype" disabled>♧<span /></button><button type="button" className="help-button" aria-label="Aide, non disponible dans ce prototype" disabled>? <span>Aide</span></button></div></header>
        <div className="page-content">
          <div className="page-heading"><div><span className="eyebrow">VOTRE TÉLÉPHONIE PROFESSIONNELLE</span><h1>{activeTab === "contacts" ? "Vos contacts" : activeTab === "messages" ? "Vos messages" : activeTab === "settings" ? "Vos appareils" : "Bonjour, bienvenue."}</h1><p>{activeTab === "contacts" ? "Un carnet partagé avec toute votre équipe." : activeTab === "messages" ? "Vos conversations, synchronisées sur vos appareils." : activeTab === "settings" ? "Consultez et révoquez les appareils associés à votre compte." : "Retrouvez votre activité et gérez votre ligne."}</p></div><div className="heading-date"><span className="date-icon">◷</span><span>{todayLabel}</span></div></div>
          {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="Fermer">×</button></div>}
          {!networkOnline && <div className="notice notice-warning" role="alert">Connexion réseau indisponible. Les données affichées peuvent être anciennes; les nouvelles actions nécessitent une connexion.</div>}
          {workspaceState === "loading" && <div className="notice" role="status" aria-live="polite">Chargement des données de votre espace…</div>}
          {workspaceState === "error" && <div className="notice notice-error" role="alert">L’espace n’a pas pu être actualisé. <button disabled={!networkOnline} onClick={() => window.location.reload()}>Réessayer</button></div>}
          <section className="line-banner"><div className="line-copy"><span className="line-label"><i /> LIGNE ACTIVE</span><h2>{activeLine?.phone_number ?? "Aucune ligne attribuée"}</h2><p>{activeLine ? "Appels et messages de votre équipe" : "Demandez à un administrateur de vous attribuer une ligne."}</p></div><div className="line-meta">{lines.filter((item) => item.lines).length > 1 && <select className="line-selector" aria-label="Ligne active" value={activeLine?.id ?? ""} disabled={voiceState !== "idle" || Boolean(pendingSmsAttempt) || smsRecoveryState !== "ready"} onChange={(event) => selectLine(event.target.value)}>{lines.filter((item) => item.lines).map((item) => <option key={item.lines!.id} value={item.lines!.id}>{item.lines!.phone_number}</option>)}</select>}<span className="line-badge">{activeLine?.voice_enabled && activeAssignment?.can_voice ? "Voix activée" : "Voix en attente"}</span><span className="line-badge muted">{activeLine?.sms_enabled && activeAssignment?.can_sms ? "SMS activés" : "SMS en attente"}</span></div><div className="banner-decoration">◌</div></section>
          {activeTab === "contacts" ? (
            <ContactPanel
              contacts={contacts}
              dataState={workspaceState}
              busy={busy}
              search={contactSearch}
              editing={editingContact}
              name={contactName}
              email={contactEmail}
              phone={contactPhone}
              onSearch={setContactSearch}
              onName={setContactName}
              onEmail={setContactEmail}
              onPhone={setContactPhone}
              onSubmit={createContact}
              onCancel={() => { setEditingContact(null); setContactName(""); setContactPhone(""); setContactEmail(""); }}
              onEdit={beginEditContact}
              onArchive={(contact) => { if (window.confirm(`Archiver ${contact.display_name} ?`)) void archiveContact(contact); }}
              onCall={(contact) => { setDestination(contact.contact_phones[0]?.phone_number ?? ""); setActiveTab("activity"); }}
              onMessage={(contact) => { const phone = contact.contact_phones[0]?.phone_number ?? ""; setMessageDestination(phone); setSelectedConversationId(conversations.find((item) => item.remoteNumber === phone)?.id ?? ""); setActiveTab("messages"); }}
            />
          ) : activeTab === "messages" ? (
            <section className="messages-workspace">
              {smsRecoveryState === "checking" && <div className="notice" role="status">Vérification des SMS en cours…</div>}
              {smsRecoveryState === "unavailable" && <div className="notice" role="alert">Impossible de vérifier les SMS précédents. <button onClick={() => void retrySmsRecovery()}>Réessayer</button></div>}
              <aside className="content-card conversation-panel">
                <div className="section-heading"><div><span className="eyebrow">MESSAGERIE</span><h2>Conversations</h2></div><span className="subtle-count">{conversations.length}</span></div>
                {conversations.length ? <div className="conversation-list">{conversations.map((conversation) => (
                  <button aria-pressed={selectedConversationId === conversation.id} className={selectedConversationId === conversation.id ? "conversation-item selected" : "conversation-item"} key={conversation.id} disabled={Boolean(pendingSmsAttempt) || smsRecoveryState !== "ready"} onClick={() => { setSelectedConversationId(conversation.id); setMessageDestination(conversation.remoteNumber); }}>
                    <span className="contact-avatar">{(conversation.remoteContactName ?? conversation.remoteNumber).slice(-2)}</span><span className="conversation-copy"><b>{conversation.remoteContactName ?? conversation.remoteNumber}</b><small>{conversation.remoteContactName ? `${conversation.remoteNumber} · ` : ""}{conversation.lastMessage?.body ?? "Aucun message"}</small></span>
                    {conversation.unread && <span className="unread-badge" aria-label="Non lu">Non lu</span>}
                    {conversation.lastMessage && <small className="conversation-time">{new Date(conversation.lastMessage.created_at).toLocaleDateString("fr-BE")}</small>}
                  </button>
                ))}</div> : <div className="empty-state compact" role={workspaceState === "loading" ? "status" : undefined}><span className="empty-icon" aria-hidden="true">▤</span><b>{workspaceState === "loading" ? "Chargement des conversations…" : workspaceState === "error" ? "Conversations indisponibles" : "Aucune conversation"}</b><p>{workspaceState === "loading" ? "Récupération des messages de votre ligne." : workspaceState === "error" ? "Vérifiez la connexion puis actualisez l’espace." : "Un premier SMS créera la conversation."}</p></div>}
              </aside>
              <section className="content-card message-thread">
                <div className="section-heading"><div><span className="eyebrow">CONVERSATION</span><h2>{(selectedConversationContactName ?? messageDestination) || "Nouveau message"}</h2>{selectedConversationContactName && <small>{messageDestination}</small>}</div><span className={activeLine?.sms_enabled && activeAssignment?.can_sms ? "line-badge" : "line-badge muted"}>{activeLine?.sms_enabled && activeAssignment?.can_sms ? "SMS activés" : "SMS en attente"}</span></div>
                <div className="message-list" aria-live="polite" aria-relevant="additions text">
                  {conversationMessages.length ? conversationMessages.map((message) => <article className={`message-bubble ${message.direction}`} key={message.id}><p>{message.body}</p><small>{new Date(message.created_at).toLocaleTimeString("fr-BE", { hour: "2-digit", minute: "2-digit" })}{message.direction === "outbound" ? ` · ${{ submitting: "Envoi…", pending: "En attente", unknown: "Vérification", sent: "Envoyé", delivered: "Livré", undelivered: "Non livré", failed: "Échec" }[message.status] ?? message.status}` : ""}</small></article>) : <div className="empty-state compact" role={workspaceState === "loading" ? "status" : undefined}><span className="empty-icon" aria-hidden="true">▤</span><b>{workspaceState === "loading" ? "Chargement des messages…" : workspaceState === "error" ? "Messages indisponibles" : "Aucun message affiché"}</b><p>{workspaceState === "loading" ? "Récupération de la conversation." : workspaceState === "error" ? "Vérifiez la connexion puis actualisez l’espace." : "Sélectionnez une conversation ou écrivez à un numéro."}</p></div>}
                </div>
                <form className="message-compose" onSubmit={sendMessage}>
                  <label>Destinataire<input inputMode="tel" value={messageDestination} disabled={Boolean(pendingSmsAttempt) || smsRecoveryState !== "ready"} onChange={(event) => setMessageDestination(event.target.value)} placeholder="+32 470 00 00 00" /></label>
                  <label>Message<textarea value={messageBody} disabled={Boolean(pendingSmsAttempt) || smsRecoveryState !== "ready"} onChange={(event) => setMessageBody(event.target.value)} maxLength={1600} rows={3} placeholder="Écrire un message…" /></label>
                  <div className="message-compose-footer"><small>{pendingSmsAttempt ? "Résultat incertain : vérifiez l’envoi avec la même demande." : `${messageBody.length}/1600 caractères`} · {smsSegmentInfo.encoding} · {smsSegmentInfo.characterCount} unités · {smsSegmentInfo.segments} segment{smsSegmentInfo.segments === 1 ? "" : "s"} estimé{smsSegmentInfo.segments === 1 ? "" : "s"} · le statut livré dépend du réseau destinataire</small><button className="button button-primary" disabled={busy || smsRecoveryState !== "ready" || !messageBody.trim() || !activeLine?.sms_enabled || !activeAssignment?.can_sms}>{busy ? "Vérification…" : pendingSmsAttempt ? "Vérifier l’envoi" : smsRecoveryState !== "ready" ? "Vérification…" : "Envoyer"}<span>↑</span></button></div>
                </form>
              </section>
            </section>
          ) : activeTab === "settings" ? (
            <section className="content-card device-settings">
              <div className="section-heading"><div><span className="eyebrow">SÉCURITÉ DU COMPTE</span><h2>Appareils enregistrés</h2></div><span className="subtle-count">{devices.filter((device) => device.organization_id === selectedOrg && device.status === "active").length} actifs</span></div>
              <div className="settings-account"><span>{session.user.email}</span>{organizations.length > 1 ? <select aria-label="Organisation active" value={selectedOrg} disabled={voiceState !== "idle" || Boolean(pendingSmsAttempt)} onChange={(event) => selectOrganization(event.target.value)}>{organizations.map((item) => <option key={item.organization_id} value={item.organization_id}>{item.organizations?.name ?? "Espace"}</option>)}</select> : <span>{organizations[0]?.organizations?.name ?? "Espace de travail"}</span>}<button className="button device-revoke" disabled={Boolean(pendingSmsAttempt)} onClick={() => void supabase?.auth.signOut()}>Se déconnecter</button></div>
              <p className="settings-status">État vocal de cet onglet : <b>{voiceStatus}</b>. Un seul onglet du profil garde la ligne enregistrée; si cet onglet se ferme, le suivant reprend la ligne.</p>
              <div className="device-list">
                {devices.filter((device) => device.organization_id === selectedOrg).map((device) => (
                  <article className="device-row" key={device.id}>
                    <span className="device-icon" aria-hidden="true">{device.platform === "web" ? "▣" : "▱"}</span>
                    <span className="device-copy">
                      <b>{device.label || device.platform}</b>
                      <small>{device.platform} · {device.status === "active" ? "Actif" : "Révoqué"}{device.last_active_at ? ` · vu ${new Date(device.last_active_at).toLocaleString("fr-BE", { dateStyle: "short", timeStyle: "short" })}` : ""}</small>
                    </span>
                    {device.status === "active" && <button className="button device-revoke" disabled={busy} onClick={() => void revokeDevice(device.id)}>Révoquer</button>}
                  </article>
                ))}
                {devices.filter((device) => device.organization_id === selectedOrg).length === 0 && (
                  <div className="empty-state compact" role={workspaceState === "loading" ? "status" : undefined}>
                    <span className="empty-icon" aria-hidden="true">▣</span>
                    <b>{workspaceState === "loading" ? "Chargement des appareils…" : workspaceState === "error" ? "Appareils indisponibles" : "Aucun appareil enregistré"}</b>
                    <p>{workspaceState === "loading" ? "Récupération des appareils du compte." : workspaceState === "error" ? "Vérifiez la connexion puis actualisez l’espace." : "Un appareil sera associé lors de la première activation de la ligne vocale."}</p>
                  </div>
                )}
              </div>
              <p className="settings-status">Version de l’application Web : <b>{webPackage.version}</b></p>
            </section>
          ) : (
            <><section className="stats-grid"><article className="stat-card"><div className="stat-icon icon-call">↗</div><span>Appels récents</span><strong>{calls.length}</strong><small>Sur la ligne sélectionnée</small></article><article className="stat-card"><div className="stat-icon icon-contact">♙</div><span>Contacts</span><strong>{contacts.length}</strong><small>Dans votre organisation</small></article><article className="stat-card"><div className="stat-icon icon-message">▤</div><span>Conversations</span><strong>{conversations.length}</strong><small>Sur la ligne sélectionnée</small></article></section><section className="dashboard-grid"><div className="content-card recent-card"><div className="section-heading"><div><span className="eyebrow">VOTRE JOURNÉE</span><h2>Activité récente</h2></div></div>{calls.length ? <div className="recent-call-list">{calls.slice(0, 8).map((call) => <div className="recent-call-row" key={call.id}><span className={`recent-call-icon ${call.direction}`} aria-hidden="true">{call.direction === "outbound" ? "↗" : "↙"}</span><div className="recent-call-copy"><b>{call.remoteContactName ?? call.remote_number}</b><small>{call.remoteContactName ? `${call.remote_number} · ` : ""}{call.direction === "outbound" ? "Appel sortant" : "Appel entrant"} · {new Date(call.created_at).toLocaleString("fr-BE", { dateStyle: "short", timeStyle: "short" })}</small></div><span className="recent-call-status">{callStatus(call.status)}</span></div>)}</div> : <div className="empty-state compact"><span className="empty-icon">◷</span><b>{workspaceState === "loading" ? "Chargement des appels…" : workspaceState === "error" ? "Historique indisponible" : "Aucun appel pour le moment"}</b><p>{workspaceState === "loading" ? "Récupération de l’activité de votre ligne." : workspaceState === "error" ? "Vérifiez la connexion puis actualisez l’espace." : "Les appels de votre ligne apparaîtront ici."}</p></div>}</div><div className="content-card compose-card"><div className="section-heading"><div><span className="eyebrow">NOUVEL APPEL</span><h2>Composer</h2></div><span className="compose-icon" aria-hidden="true">⌕</span></div><label className="number-entry"><span>Numéro de téléphone</span><input inputMode="tel" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="+32 470 00 00 00" disabled={voiceState !== "idle" || !voiceTabOwner} /></label>{destinationContact && <p className="compose-hint" role="status">Contact de votre organisation : {destinationContact.display_name}</p>}<div className="dial-pad" role="group" aria-label="Clavier téléphonique">{["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((digit, index) => <button type="button" key={digit} aria-label={voiceState === "active" ? `Envoyer la tonalité ${digit}` : `Ajouter ${digit} au numéro`} disabled={!voiceTabOwner || (voiceState === "idle" && (digit === "#" || digit === "*"))} onClick={() => voiceState === "active" ? voiceClient.current?.sendDigits(digit) : setDestination((value) => `${value}${digit}`)}>{digit}{index > 0 && index < 9 && <small aria-hidden="true">{["", "ABC", "DEF", "GHI", "JKL", "MNO", "PQRS", "TUV", "WXYZ"][index]}</small>}</button>)}</div>{voiceState === "idle" ? <button className="button button-call button-wide" disabled={!voiceTabOwner || !destination || busy || !activeLine?.voice_enabled || !activeAssignment?.can_voice} onClick={() => void startVoiceCall()}><span aria-hidden="true">⌕</span>{busy ? "Préparation…" : "Appeler"}</button> : <div className="voice-active-controls"><p role="status">{incomingFrom ? `Appel entrant de ${incomingFrom}` : voiceStatus}</p>{incomingFrom && <div className="voice-action-row"><button className="button button-primary" onClick={() => voiceClient.current?.acceptCall()}>Répondre</button><button className="button" onClick={() => voiceClient.current?.rejectCall()}>Refuser</button></div>}{voiceState === "active" && <div className="voice-action-row"><button aria-pressed={muted} className={muted ? "button button-primary" : "button"} onClick={() => voiceClient.current?.setMuted(!muted)}>{muted ? "Rétablir le son" : "Muet"}</button><button className="button button-danger" onClick={() => voiceClient.current?.hangUp()}>Raccrocher</button></div>}</div>}<p className="compose-hint">{activeLine?.voice_enabled && activeAssignment?.can_voice ? voiceStatus : "Les appels sont désactivés dans cet environnement."}</p></div></section></>
          )}
          <footer className="page-footer"><span>onoff <b>·</b> Prototype privé</span><span>Vos données sont synchronisées en toute sécurité.</span></footer>
        </div>
      </main>
    </div>
  );
}
