import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CheckCircle, Code, DeviceMobile, Microphone, Monitor, Phone, Plug, Plus, SignOut, Tag, UserCircle } from "@phosphor-icons/react";
import type { ServiceStatus } from "@onoff/contracts";
import { ApiIntegrations } from "./ApiIntegrations";
import { McpIntegrations } from "./McpIntegrations";
import { TagManager } from "./Tags";
import { Avatar, EmptyState } from "./ui";
import { formatPhone } from "./conversation-model";
import { settingsTabFromSearch, settingsTabs, type SettingsTab } from "./settings-navigation";
import webPackage from "../package.json";
import "./section-tabs.css";

export type LineAssignment = { can_voice: boolean; can_sms: boolean; lines: { id: string; phone_number: string; voice_enabled: boolean; sms_enabled: boolean } | null };
export type DeviceRecord = { id: string; organization_id: string; platform: string; label: string; status: string; last_active_at: string | null; created_at: string };
type Props = {
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  email: string | undefined;
  organizationId: string;
  organizationName: string;
  lines: LineAssignment[];
  activeLineId: string | undefined;
  devices: DeviceRecord[];
  services: ServiceStatus | null;
  isAdmin: boolean;
  voiceStatus: string;
  canReconnect: boolean;
  disabledActions: { signOut: boolean; lines: boolean; purchase: boolean; devices: boolean; reconnect: boolean };
  onSignOut(): void;
  onPurchase(): void;
  onSelectLine(id: string): void;
  onRevokeDevice(id: string): void;
  onReconnect(): void;
};
const tabDetails = {
  account: { label: "Compte", icon: UserCircle },
  lines: { label: "Lignes", icon: Phone },
  devices: { label: "Appareils & appels", icon: Monitor },
  tags: { label: "Tags IA", icon: Tag },
  api: { label: "API & webhooks", icon: Code },
  assistants: { label: "Assistants IA", icon: Plug },
};

export function Settings(props: Props) {
  const { api, email, organizationId, organizationName, lines, activeLineId, devices, services, isAdmin, voiceStatus, canReconnect, disabledActions, onSignOut, onPurchase, onSelectLine, onRevokeDevice, onReconnect } = props;
  const [tab, setTab] = useState<SettingsTab>(() => settingsTabFromSearch(window.location.search) ?? "account");
  const [visited, setVisited] = useState(() => new Set<SettingsTab>([tab]));
  const tabButtons = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});
  const assignedLines = lines.flatMap((assignment) => assignment.lines ? [{ ...assignment, lines: assignment.lines }] : []);
  const activeDeviceCount = devices.filter((device) => device.status === "active").length;

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("settings", tab);
    window.history.replaceState(window.history.state, "", url);
    tabButtons.current[tab]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);

  function selectTab(next: SettingsTab) {
    setTab(next);
    setVisited((current) => current.has(next) ? current : new Set([...current, next]));
  }

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, current: SettingsTab) {
    const index = settingsTabs.indexOf(current);
    const next = event.key === "ArrowRight" ? settingsTabs[(index + 1) % settingsTabs.length]
      : event.key === "ArrowLeft" ? settingsTabs[(index + settingsTabs.length - 1) % settingsTabs.length]
      : event.key === "Home" ? settingsTabs[0]
      : event.key === "End" ? settingsTabs[settingsTabs.length - 1] : undefined;
    if (!next) return;
    event.preventDefault();
    selectTab(next);
    tabButtons.current[next]?.focus({ preventScroll: true });
  }

  // Keep visited panels mounted so tab switches preserve drafts and one-time webhook secrets.
  function panel(id: SettingsTab, children: ReactNode) {
    return <div id={`settings-panel-${id}`} role="tabpanel" aria-labelledby={`settings-tab-${id}`} className="settings-panel" hidden={tab !== id} tabIndex={0}>
      {visited.has(id) && children}
    </div>;
  }

  return <section className="settings-page">
    <div className="section-tabs settings-tabs" role="tablist" aria-label="Rubriques des réglages">
      {settingsTabs.map((id) => {
        const { label, icon: Icon } = tabDetails[id];
        return <button type="button" key={id} ref={(element) => { tabButtons.current[id] = element; }} id={`settings-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`settings-panel-${id}`} tabIndex={tab === id ? 0 : -1} className={tab === id ? "active" : ""} onClick={() => selectTab(id)} onKeyDown={(event) => navigateTabs(event, id)}>
          <Icon size={17} aria-hidden="true" />{label}{id === "lines" && <span>{assignedLines.length}</span>}
        </button>;
      })}
    </div>

    {panel("account", <section className="settings-section">
      <h3>Mon compte</h3>
      <div className="account-row"><Avatar name={email ?? "Moi"} /><div><b>{email ?? "Mon compte"}</b><p>{organizationName} · {isAdmin ? "Administrateur" : "Membre de l’équipe"}</p></div><button type="button" className="button button-secondary" disabled={disabledActions.signOut} onClick={onSignOut}><SignOut size={17} />Se déconnecter</button></div>
    </section>)}

    {panel("lines", <section className="settings-section">
      <div className="settings-section-heading"><h3>Mes lignes</h3>{isAdmin && <button type="button" className="text-button" disabled={disabledActions.purchase} onClick={onPurchase}><Plus size={16} />Ajouter une ligne</button>}</div>
      {assignedLines.map((item) => <div className="settings-line-row" key={item.lines.id}>
        <Phone size={21} /><div><b>{formatPhone(item.lines.phone_number)}</b><p>{services?.voiceEnabled && !services.operationsPaused && item.can_voice && item.lines.voice_enabled ? "Appels activés" : "Appels indisponibles"} · {services?.smsEnabled && !services.operationsPaused && item.can_sms && item.lines.sms_enabled ? "SMS activés" : "SMS indisponibles"}</p></div>
        {item.lines.id === activeLineId ? <span className="selected-line"><CheckCircle size={16} />Sélectionnée</span> : <button type="button" className="button button-secondary" disabled={disabledActions.lines} onClick={() => onSelectLine(item.lines.id)}>Utiliser cette ligne</button>}
      </div>)}
      {!assignedLines.length && <EmptyState icon={<Phone size={26} />} title="Aucune ligne attribuée"><p>{isAdmin ? "Ajoutez une ligne ou gérez vos accès dans l’administration." : "Un administrateur peut vous attribuer une ligne dans cet espace."}</p></EmptyState>}
    </section>)}

    {panel("devices", <>
      <section className="settings-section">
        <div className="settings-section-heading"><h3>Appareils connectés</h3><span>{activeDeviceCount} actif{activeDeviceCount > 1 ? "s" : ""}</span></div>
        {devices.map((device) => <div className="device-row" key={device.id}>
          <span className="device-icon">{device.platform === "web" ? <Monitor /> : <DeviceMobile />}</span><div><b>{device.label || device.platform}</b><p>{device.status === "active" ? "Actif" : "Révoqué"}{device.last_active_at ? ` · ${new Date(device.last_active_at).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}` : ""}</p></div>
          {device.status === "active" && <button type="button" className="text-button danger-text" disabled={disabledActions.devices} onClick={() => onRevokeDevice(device.id)}>Révoquer</button>}
        </div>)}
        {!devices.length && <EmptyState icon={<Monitor size={26} />} title="Aucun appareil enregistré"><p>Votre navigateur sera associé lors de l’activation des appels.</p></EmptyState>}
      </section>
      <section className="settings-section"><h3>État des appels</h3><p className="voice-settings-status" role="status"><Microphone size={17} />{voiceStatus}</p>{canReconnect && <button type="button" className="text-button" disabled={disabledActions.reconnect} onClick={onReconnect}>Reconnecter cet appareil</button>}<p className="settings-description">Un seul onglet reçoit les appels ; un autre prend le relais à sa fermeture.</p></section>
    </>)}

    {panel("tags", organizationId ? <TagManager api={api} organizationId={organizationId} /> : <EmptyState icon={<Tag size={26} />} title="Aucun espace sélectionné"><p>Sélectionnez un espace pour gérer ses tags.</p></EmptyState>)}
    {panel("api", organizationId ? <ApiIntegrations key={`${organizationId}:${isAdmin}`} api={api} organizationId={organizationId} isAdmin={isAdmin} /> : <EmptyState icon={<Code size={26} />} title="Aucun espace sélectionné"><p>Sélectionnez un espace pour consulter ses intégrations.</p></EmptyState>)}
    {panel("assistants", <McpIntegrations api={api} initialDraftId={new URLSearchParams(window.location.search).get("mcpSms") ?? ""} />)}
    <p className="settings-version">onoff · Version {webPackage.version}</p>
  </section>;
}
