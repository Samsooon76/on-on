import { useRef, useState, type ReactNode } from "react";
import { ArrowBendUpLeft, ArrowCounterClockwise, ArrowClockwise, ArrowRight, Check, Clock, FloppyDisk, GearSix, GitBranch, Headset, Microphone, Phone, PhoneDisconnect, Plus, Trash, User, Voicemail } from "@phosphor-icons/react";
import { defaultVoiceFlow, queueConfigSchema, voiceFlowSchema, type AdminLine, type CenterSnapshot, type QueueConfig, type VoiceDestination, type VoiceFlow, type VoiceFlowRecord, type VoiceQueue } from "@onoff/contracts";
import { Modal } from "./ui";
import { formatPhone } from "./conversation-model";
import { addSubmenu, digits, nextDigit, pruneMenus, readDestination, referencedQueueIds, removeBranch, replaceDestination, type DestinationAddress, type IvrMenu } from "./ivr-builder-model";
import "./ivr-builder.css";

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
type Member = { user_id: string; display_name: string };
type Selection = DestinationAddress | { kind: "greeting" | "settings" | "hours" } | { kind: "menu"; menuId: string };
type Props = { line: AdminLine; record: VoiceFlowRecord | undefined; queues: VoiceQueue[]; members?: Member[]; api: Api; base: string; onClose(): void; onSaved(published: boolean): Promise<void> };
const message = (error: unknown) => error instanceof Error ? error.message : "Impossible d’enregistrer le parcours.";
const queueDefaults = (name: string, memberIds: string[]): QueueConfig => ({ name, memberIds, maxWaitSeconds: 120, ringTimeout: 25, holdMessage: "Tous nos conseillers sont occupés. Nous allons prendre votre appel.", holdMusicUrl: null, announcePosition: true, overflow: { type: "voicemail" } });

function destinationIcon(destination: VoiceDestination) {
  return destination.type === "queue" ? <Headset/> : destination.type === "number" ? <Phone/> : destination.type === "menu" ? <GitBranch/> : destination.type === "voicemail" ? <Voicemail/> : <PhoneDisconnect/>;
}
function destinationName(destination: VoiceDestination, queues: VoiceQueue[], menus: IvrMenu[]) {
  switch (destination.type) {
    case "queue": return queues.find(queue => queue.id === destination.queueId)?.config.name || "Choisir une file";
    case "number": return destination.number ? formatPhone(destination.number) : "Choisir un numéro";
    case "menu": return menus.find(menu => menu.id === destination.menuId)?.name || "Sous-menu";
    case "voicemail": return "Messagerie vocale";
    case "hangup": return "Fin de l’appel";
  }
}

export function FlowEditor({ line, record, queues, members = [], api, base, onClose, onSaved }: Props) {
  const [history, setHistory] = useState<{ past: VoiceFlow[]; present: VoiceFlow; future: VoiceFlow[] }>(() => ({ past: [], present: record ? structuredClone(record.draft) : defaultVoiceFlow(), future: [] }));
  const flow = history.present;
  const [requestedSelection, setSelection] = useState<Selection>({ kind: "greeting" });
  const [trail, setTrail] = useState<string[]>([]);
  const [localQueues, setLocalQueues] = useState<VoiceQueue[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const version = useRef(record?.version ?? 0);
  const queueVersions = useRef(new Map<string, number>());
  const allQueues = [...queues.filter(queue => !localQueues.some(local => local.id === queue.id)), ...localQueues];
  const entryMenuId = flow.entry.type === "menu" ? flow.entry.menuId : undefined;
  const rootMenu = flow.menus.find(menu => menu.id === entryMenuId);
  const path = trail.filter(id => flow.menus.some(menu => menu.id === id));
  const visibleMenu = flow.menus.find(menu => menu.id === path.at(-1)) ?? rootMenu;
  const requestedMenu = "menuId" in requestedSelection ? flow.menus.find(menu => menu.id === requestedSelection.menuId) : undefined;
  const selection: Selection = "menuId" in requestedSelection && (!requestedMenu || requestedSelection.kind === "branch" && !requestedMenu.options[requestedSelection.index])
    ? visibleMenu ? { kind: "menu", menuId: visibleMenu.id } : { kind: "greeting" }
    : requestedSelection;
  const selectedMenu = "menuId" in selection ? flow.menus.find(menu => menu.id === selection.menuId) : undefined;
  const selectedOption = selection.kind === "branch" ? selectedMenu?.options[selection.index] : undefined;
  const address = selection.kind === "entry" || selection.kind === "closed" || selection.kind === "fallback" || selection.kind === "branch" ? selection : undefined;
  const selectedDestination = address ? readDestination(flow, address) : undefined;

  function change(next: VoiceFlow) {
    setHistory(current => ({ past: [...current.past.slice(-49), current.present], present: next, future: [] }));
    setError("");
  }
  function undo() { setHistory(current => current.past.length ? { past: current.past.slice(0, -1), present: current.past.at(-1)!, future: [current.present, ...current.future] } : current); setError(""); }
  function redo() { setHistory(current => current.future.length ? { past: [...current.past, current.present], present: current.future[0]!, future: current.future.slice(1) } : current); setError(""); }
  function patchMenu(id: string, patch: Partial<IvrMenu>) { change({ ...flow, menus: flow.menus.map(menu => menu.id === id ? { ...menu, ...patch } : menu) }); }
  function patchOption(patch: Partial<IvrMenu["options"][number]>) {
    if (selection.kind !== "branch" || !selectedMenu) return;
    patchMenu(selectedMenu.id, { options: selectedMenu.options.map((option, index) => index === selection.index ? { ...option, ...patch } : option) });
  }
  function addBranch(menu: IvrMenu) {
    const digit = nextDigit(menu); if (!digit) return;
    patchMenu(menu.id, { options: [...menu.options, { digit, label: "", destination: { type: "voicemail" } }] });
    setSelection({ kind: "branch", menuId: menu.id, index: menu.options.length });
  }
  function openMenu(id: string) {
    const existing = path.indexOf(id);
    setTrail(id === rootMenu?.id ? [] : existing >= 0 ? path.slice(0, existing + 1) : [...path, id]);
    setSelection({ kind: "menu", menuId: id });
  }
  function createMenu(target: DestinationAddress) {
    const id = `menu_${crypto.randomUUID().replaceAll("-", "")}`;
    const next = addSubmenu(flow, target, id);
    if (next === flow) return;
    change(next); setTrail(target.kind === "entry" ? [] : [...path, id]); setSelection({ kind: "menu", menuId: id });
  }
  function newQueue(name: string, memberIds: string[]) {
    const id = crypto.randomUUID();
    setLocalQueues(current => [...current, { id, line_id: line.id, version: 0, provisioned: false, config: queueDefaults(name, memberIds) }]);
    return id;
  }
  function editQueue(id: string, patch: Partial<QueueConfig>) { setLocalQueues(current => current.map(queue => queue.id === id ? { ...queue, config: { ...queue.config, ...patch } } : queue)); }
  async function save(publish: boolean) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const config = pruneMenus(flow);
      const parsed = voiceFlowSchema.safeParse(config);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        if (issue?.path[0] === "menus" && typeof issue.path[1] === "number") {
          const menu = config.menus[issue.path[1]];
          if (menu) { openMenu(menu.id); if (issue.path[2] === "options" && typeof issue.path[3] === "number") setSelection({ kind: "branch", menuId: menu.id, index: issue.path[3] }); }
        }
        throw new Error(issue?.path.includes("label") ? "Donnez un nom à chaque branche." : issue?.path.includes("queueId") ? "Choisissez l’agent ou la file de cette branche." : issue?.path.at(-1) === "options" ? "Ajoutez au moins une branche à ce menu." : issue?.message);
      }
      const referenced = referencedQueueIds(config);
      const pending = localQueues.filter(queue => referenced.has(queue.id));
      for (const queue of pending) {
        const result = queueConfigSchema.safeParse(queue.config);
        if (!result.success) throw new Error(`${queue.config.name} : ${result.error.issues[0]?.message}`);
      }
      if (pending.length) await api(`${base}/setup`, { method: "POST" });
      for (const queue of pending) {
        const result = await api<{ version: number }>(`${base}/queues/${queue.id}`, { method: "PUT", body: JSON.stringify({ lineId: line.id, version: queueVersions.current.get(queue.id) ?? 0, config: queue.config }) });
        queueVersions.current.set(queue.id, result.version);
      }
      if (publish) await api(`${base}/lines/${line.id}/connect`, { method: "POST" });
      const result = await api<{ version: number }>(`${base}/flows/${line.id}`, { method: "PUT", body: JSON.stringify({ config: parsed.data, version: version.current, publish }) });
      version.current = result.version;
      await onSaved(publish);
    } catch (cause) {
      setError(message(cause));
      // Recover queue versions after a partially successful provisioning request.
      if (localQueues.length) try { const current = await api<CenterSnapshot>(base); current.queues.forEach(queue => { if (localQueues.some(local => local.id === queue.id)) queueVersions.current.set(queue.id, queue.version); }); } catch { /* Keep the actionable original error. */ }
    } finally { setBusy(false); }
  }

  const picker = (target: DestinationAddress, destination: VoiceDestination) => <DestinationPicker
    key={JSON.stringify(target)} value={destination} queues={allQueues} localIds={localQueues.map(queue => queue.id)} members={members} menus={flow.menus}
    onChange={next => change(replaceDestination(flow, target, next))} onNewMenu={() => createMenu(target)} canAddMenu={flow.menus.length < 12}
    onNewQueue={newQueue} onEditQueue={editQueue} onOpenMenu={openMenu}/>;
  const routeName = (destination: VoiceDestination) => destinationName(destination, allQueues, flow.menus);
  const panelTitle = selection.kind === "greeting" ? "Message d’accueil" : selection.kind === "settings" ? "Réglages du parcours" : selection.kind === "hours" ? "Horaires d’ouverture" : selection.kind === "menu" ? selectedMenu?.name ?? "Menu" : selection.kind === "branch" ? `Branche · touche ${selectedOption?.digit ?? ""}` : selection.kind === "fallback" ? "Sans réponse au menu" : selection.kind === "closed" ? "En dehors des horaires" : "Après l’accueil";

  return <Modal title="Votre parcours d’appel" className="ivr-builder" onClose={onClose} busy={busy}>
    <fieldset className="ivr-builder-fields" disabled={busy}>
      <div className="ivr-toolbar">
        <div className="ivr-identity"><label><span className="sr-only">Nom de l’IVR</span><input maxLength={80} value={flow.name} onChange={event => change({ ...flow, name: event.target.value })}/></label><span>{formatPhone(line.phone_number) || "Accueil téléphonique"}<i/>{record?.published?.enabled ? "Version publiée disponible" : "Brouillon"}</span></div>
        <div className="ivr-toolbar-actions"><div className="ivr-history"><button type="button" className="icon-button" title="Annuler la modification" aria-label="Annuler la modification" disabled={!history.past.length || busy} onClick={undo}><ArrowCounterClockwise/></button><button type="button" className="icon-button" title="Rétablir la modification" aria-label="Rétablir la modification" disabled={!history.future.length || busy} onClick={redo}><ArrowClockwise/></button></div><button type="button" className="button button-secondary ivr-save" onClick={() => void save(false)}><FloppyDisk/>Enregistrer</button><button type="button" className="button button-primary" onClick={() => void save(true)}>{busy ? "Enregistrement…" : flow.enabled ? "Publier le parcours" : "Désactiver l’IVR"}<ArrowRight/></button></div>
      </div>
      {error && <p className="ivr-error" role="alert">{error}</p>}
      <div className="ivr-workspace">
        <div className="ivr-canvas">
          <div className="ivr-canvas-toolbar"><nav aria-label="Niveaux du parcours"><button type="button" onClick={() => { setTrail([]); setSelection({ kind: "greeting" }); }}>Vue d’ensemble</button>{path.map((id, index) => <span key={id}><span aria-hidden="true">/</span><button type="button" onClick={() => { setTrail(path.slice(0, index + 1)); setSelection({ kind: "menu", menuId: id }); }}>{flow.menus.find(menu => menu.id === id)?.name}</button></span>)}</nav><div className="ivr-canvas-tools"><button type="button" className={`ivr-hours ${selection.kind === "hours" ? "selected" : ""}`} onClick={() => setSelection({ kind: "hours" })}><Clock/>{flow.schedule.enabled ? `${flow.schedule.opensAt} – ${flow.schedule.closesAt}` : "24 h / 24"}</button><button type="button" className={`ivr-settings-button ${selection.kind === "settings" ? "selected" : ""}`} onClick={() => setSelection({ kind: "settings" })}><GearSix/>Réglages</button></div></div>
          <div className="ivr-tree">
            {!path.length && <><Node selected={selection.kind === "greeting"} icon={<Microphone/>} eyebrow="Appel entrant · Accueillir" title="Message d’accueil" description={flow.greetingAudioUrl ? "Annonce audio" : flow.greeting || "Aucun message d’accueil"} onClick={() => setSelection({ kind: "greeting" })}/><div className="ivr-wire"/></>}
            {path.length > 0 && <><button type="button" className="ivr-back" onClick={() => { setTrail(path.slice(0, -1)); setSelection({ kind: "greeting" }); }}><ArrowBendUpLeft/>Niveau précédent</button><div className="ivr-wire"/></>}
            {visibleMenu ? <>
              <Node selected={selection.kind === "menu" && selection.menuId === visibleMenu.id} icon={<GitBranch/>} eyebrow={path.length ? "Sous-menu" : "02 · Orienter"} title={visibleMenu.name} description={visibleMenu.prompt} onClick={() => setSelection({ kind: "menu", menuId: visibleMenu.id })}/>
              <div className="ivr-wire"/>
              <div className="ivr-branches" role="group" aria-label={`Branches de ${visibleMenu.name}`}>
                {visibleMenu.options.map((option, index) => <div className="ivr-branch" key={option.digit}>
                  <button type="button" className={`ivr-branch-condition ${selection.kind === "branch" && selection.menuId === visibleMenu.id && selection.index === index ? "selected" : ""}`} onClick={() => setSelection({ kind: "branch", menuId: visibleMenu.id, index })}><kbd>{option.digit}</kbd><span>{option.label || "Nommer la branche"}</span></button>
                  <div className="ivr-wire"/>
                  <Node compact selected={selection.kind === "branch" && selection.menuId === visibleMenu.id && selection.index === index} icon={destinationIcon(option.destination)} eyebrow={option.destination.type === "menu" ? "Sous-menu" : option.destination.type === "queue" ? "Faire sonner" : "Destination"} title={routeName(option.destination)} onClick={() => setSelection({ kind: "branch", menuId: visibleMenu.id, index })}/>
                  {option.destination.type === "menu" ? <button type="button" className="ivr-continue" onClick={() => { if (option.destination.type === "menu") openMenu(option.destination.menuId); }}>Ouvrir les branches <ArrowRight/></button> : <button type="button" className="ivr-extend" aria-label={`Ajouter un sous-menu après la touche ${option.digit}`} title="Ajouter un sous-menu" disabled={flow.menus.length >= 12} onClick={() => createMenu({ kind: "branch", menuId: visibleMenu.id, index })}><Plus/></button>}
                </div>)}
                <div className="ivr-branch ivr-branch-add"><button type="button" className="ivr-add" disabled={visibleMenu.options.length >= 10} onClick={() => addBranch(visibleMenu)}><Plus/><span>Ajouter une branche</span><small>{visibleMenu.options.length >= 10 ? "10 touches utilisées" : "Une touche, une destination"}</small></button></div>
              </div>
              <button type="button" className={`ivr-fallback ${selection.kind === "fallback" && selection.menuId === visibleMenu.id ? "selected" : ""}`} onClick={() => setSelection({ kind: "fallback", menuId: visibleMenu.id })}><Clock/>Sans choix après {visibleMenu.maxAttempts} tentative{visibleMenu.maxAttempts > 1 ? "s" : ""}<ArrowRight/>{routeName(visibleMenu.fallback)}</button>
            </> : <><Node icon={destinationIcon(flow.entry)} eyebrow="02 · Destination" title={routeName(flow.entry)} selected={selection.kind === "entry"} onClick={() => setSelection({ kind: "entry" })}/><button type="button" className="ivr-create-menu" onClick={() => createMenu({ kind: "entry" })} disabled={flow.menus.length >= 12}><Plus/>Ajouter des branches</button></>}
            {flow.schedule.enabled && !path.length && <button type="button" className="ivr-fallback" onClick={() => setSelection({ kind: "closed" })}><Clock/>En dehors des horaires<ArrowRight/>{routeName(flow.schedule.closed)}</button>}
          </div>
          <p className="ivr-canvas-hint">Cliquez sur un bloc pour le modifier. Ajoutez vos choix avec +.</p>
        </div>
        <aside className="ivr-inspector" aria-label="Modifier le bloc sélectionné">
          <div className="ivr-inspector-heading"><span>PERSONNALISER</span><h3>{panelTitle}</h3></div>
          <div className="ivr-inspector-body">
            {selection.kind === "greeting" && <>
              <p className="ivr-help">Le premier message entendu par vos appelants.</p>
              <label className="field-label">Votre message<textarea rows={4} maxLength={1000} value={flow.greeting} onChange={event => change({ ...flow, greeting: event.target.value })}/></label>
              <label className="field-label">Langue<select value={flow.language} onChange={event => change({ ...flow, language: event.target.value as VoiceFlow["language"] })}><option value="fr-FR">Français</option><option value="en-GB">English (UK)</option><option value="en-US">English (US)</option></select></label>
              <details className="ivr-details"><summary>Utiliser un fichier audio</summary><label className="field-label">Lien HTTPS de l’annonce<input type="url" placeholder="https://…/bienvenue.mp3" value={flow.greetingAudioUrl ?? ""} onChange={event => change({ ...flow, greetingAudioUrl: event.target.value || null })}/><small>L’audio remplace le texte d’accueil.</small></label></details>
              <button type="button" className="ivr-panel-link" onClick={() => setSelection({ kind: "entry" })}>Après l’accueil : {routeName(flow.entry)}<ArrowRight/></button>
            </>}
            {selection.kind === "menu" && selectedMenu && <>
              <label className="field-label">Nom du menu<input maxLength={80} value={selectedMenu.name} onChange={event => patchMenu(selectedMenu.id, { name: event.target.value })}/></label>
              <label className="field-label">Annonce du menu<textarea rows={3} maxLength={1000} value={selectedMenu.prompt} onChange={event => patchMenu(selectedMenu.id, { prompt: event.target.value })}/><small>Les choix « Pour …, tapez … » sont ajoutés automatiquement.</small></label>
              <div className="ivr-spoken-preview"><Microphone size={16}/><p>{selectedMenu.prompt} {selectedMenu.options.map(option => `Pour ${option.label || "…"}, tapez ${option.digit}.`).join(" ")}</p></div>
              <button type="button" className="button button-secondary" disabled={selectedMenu.options.length >= 10} onClick={() => addBranch(selectedMenu)}><Plus/>Ajouter une branche</button>
              <button type="button" className="ivr-panel-link" onClick={() => setSelection({ kind: "fallback", menuId: selectedMenu.id })}>Attente et absence de choix<ArrowRight/></button>
            </>}
            {selection.kind === "branch" && selectedMenu && selectedOption && <>
              <div className="ivr-option-fields"><label className="field-label">Touche<select value={selectedOption.digit} onChange={event => patchOption({ digit: event.target.value })}>{digits.map(digit => <option key={digit} disabled={selectedMenu.options.some((option, index) => index !== selection.index && option.digit === digit)}>{digit}</option>)}</select></label><label className="field-label">Pour…<input key={`${selectedMenu.id}:${selection.index}`} autoFocus maxLength={80} placeholder="le service commercial" value={selectedOption.label} onChange={event => patchOption({ label: event.target.value })}/></label></div>
              <p className="ivr-spoken-line">« Pour {selectedOption.label || "…"}, tapez {selectedOption.digit}. »</p>
            </>}
            {selection.kind === "fallback" && selectedMenu && <>
              <p className="ivr-help">Si l’appelant ne saisit aucune touche ou choisit une touche invalide.</p>
              <label className="field-label">Attente par tentative (secondes)<input type="number" min={3} max={15} value={selectedMenu.timeout} onChange={event => patchMenu(selectedMenu.id, { timeout: Number(event.target.value) })}/></label>
              <label className="field-label">Nombre de tentatives<select value={selectedMenu.maxAttempts} onChange={event => patchMenu(selectedMenu.id, { maxAttempts: Number(event.target.value) })}>{[1, 2, 3].map(count => <option key={count}>{count}</option>)}</select></label>
            </>}
            {address && selectedDestination && picker(address, selectedDestination)}
            {selection.kind === "branch" && selectedOption && <button type="button" className="ivr-delete" onClick={() => { change(removeBranch(flow, selection.menuId, selection.index)); setSelection({ kind: "menu", menuId: selection.menuId }); }}><Trash/>Supprimer cette branche</button>}
            {selection.kind === "hours" && <>
              <label className="ivr-toggle"><input type="checkbox" checked={flow.schedule.enabled} onChange={event => change({ ...flow, schedule: { ...flow.schedule, enabled: event.target.checked } })}/><span>Définir des horaires d’ouverture</span></label>
              {!flow.schedule.enabled ? <p className="ivr-help">Ce parcours accueille les appels à toute heure.</p> : <>
                <div className="ivr-days">{["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"].map((day, index) => <label key={day}><input type="checkbox" checked={flow.schedule.days.includes(index + 1)} onChange={event => change({ ...flow, schedule: { ...flow.schedule, days: event.target.checked ? [...flow.schedule.days, index + 1] : flow.schedule.days.filter(value => value !== index + 1) } })}/><span>{day}</span></label>)}</div>
                <div className="ivr-two-fields"><label className="field-label">Ouverture<input type="time" value={flow.schedule.opensAt} onChange={event => change({ ...flow, schedule: { ...flow.schedule, opensAt: event.target.value } })}/></label><label className="field-label">Fermeture<input type="time" value={flow.schedule.closesAt} onChange={event => change({ ...flow, schedule: { ...flow.schedule, closesAt: event.target.value } })}/></label></div>
                <label className="field-label">Fuseau horaire<input value={flow.schedule.timezone} placeholder="Europe/Paris" onChange={event => change({ ...flow, schedule: { ...flow.schedule, timezone: event.target.value } })}/></label>
                <button type="button" className="ivr-panel-link" onClick={() => setSelection({ kind: "closed" })}>En dehors des horaires : {routeName(flow.schedule.closed)}<ArrowRight/></button>
              </>}
            </>}
            {selection.kind === "settings" && <>
              <label className="ivr-toggle"><input type="checkbox" checked={flow.enabled} onChange={event => change({ ...flow, enabled: event.target.checked })}/><span>Activer ce parcours</span></label>
              {!flow.enabled && <p className="ivr-help">La publication rétablira les appels directs sur le numéro.</p>}
              <label className="field-label">Annonce de messagerie<textarea rows={4} maxLength={1000} value={flow.voicemailGreeting} onChange={event => change({ ...flow, voicemailGreeting: event.target.value })}/></label>
              <label className="field-label">Durée maximale du message (secondes)<input type="number" min={10} max={300} value={flow.maxRecordingSeconds} onChange={event => change({ ...flow, maxRecordingSeconds: Number(event.target.value) })}/></label>
              <details className="ivr-details"><summary>Renvois vers un numéro externe</summary><label className="field-label">Durée de sonnerie (secondes)<input type="number" min={5} max={60} value={flow.ringTimeout} onChange={event => change({ ...flow, ringTimeout: Number(event.target.value) })}/></label><label className="field-label">Sans réponse<select value={flow.noAnswer} onChange={event => change({ ...flow, noAnswer: event.target.value as VoiceFlow["noAnswer"] })}><option value="voicemail">Messagerie vocale</option><option value="hangup">Fin de l’appel</option></select></label></details>
              <button type="button" className="ivr-panel-link" onClick={() => setSelection({ kind: "hours" })}><Clock/>Horaires d’ouverture<ArrowRight/></button>
            </>}
          </div>
        </aside>
      </div>
      <div className="ivr-bottom"><span><Check/>Les modifications restent en brouillon jusqu’à leur publication.</span><span>{flow.menus.reduce((total, menu) => total + menu.options.length, 0)} branche{flow.menus.reduce((total, menu) => total + menu.options.length, 0) > 1 ? "s" : ""} · {flow.menus.length} menu{flow.menus.length > 1 ? "s" : ""}</span></div>
    </fieldset>
  </Modal>;
}

function Node({ icon, eyebrow, title, description, onClick, selected = false, compact = false }: { icon: ReactNode; eyebrow: string; title: string; description?: string; onClick(): void; selected?: boolean; compact?: boolean }) {
  return <button type="button" className={`ivr-node ${selected ? "selected" : ""} ${compact ? "compact" : ""}`} onClick={onClick}><span className="ivr-node-icon">{icon}</span><span className="ivr-node-copy"><small>{eyebrow}</small><strong>{title}</strong>{description && <span>{description}</span>}</span></button>;
}

function DestinationPicker({ value, queues, localIds, members, menus, onChange, onNewMenu, canAddMenu, onNewQueue, onEditQueue, onOpenMenu }: {
  value: VoiceDestination; queues: VoiceQueue[]; localIds: string[]; members: Member[]; menus: IvrMenu[];
  onChange(destination: VoiceDestination): void; onNewMenu(): void; canAddMenu: boolean;
  onNewQueue(name: string, memberIds: string[]): string; onEditQueue(id: string, patch: Partial<QueueConfig>): void; onOpenMenu(id: string): void;
}) {
  const currentQueue = value.type === "queue" ? queues.find(queue => queue.id === value.queueId) : undefined;
  const [mode, setMode] = useState<string>(currentQueue?.config.memberIds.length === 1 ? "agent" : value.type);
  const kind = value.type === "queue" ? mode === "agent" ? "agent" : "queue" : value.type;
  const choices = [{ id: "agent", label: "Un agent", icon: <User/> }, { id: "queue", label: "Une file", icon: <Headset/> }, { id: "number", label: "Un numéro", icon: <Phone/> }, { id: "menu", label: "Un sous-menu", icon: <GitBranch/> }, { id: "voicemail", label: "Messagerie", icon: <Voicemail/> }, { id: "hangup", label: "Raccrocher", icon: <PhoneDisconnect/> }];
  function choose(id: string) {
    setMode(id);
    if (id === "agent") onChange({ type: "queue", queueId: "" });
    else if (id === "queue") onChange({ type: "queue", queueId: queues[0]?.id ?? "" });
    else if (id === "number") onChange({ type: "number", number: "" });
    else if (id === "menu") { if (canAddMenu) onNewMenu(); else if (menus[0]) onChange({ type: "menu", menuId: menus[0].id }); }
    else onChange({ type: id as "voicemail" | "hangup" });
  }
  return <div className="ivr-destination-picker">
    <span className="field-label">Diriger l’appel vers</span>
    <div className="ivr-destination-types">{choices.map(choice => <button key={choice.id} type="button" aria-pressed={kind === choice.id} className={kind === choice.id ? "selected" : ""} onClick={() => { if (kind !== choice.id) choose(choice.id); }}>{choice.icon}{choice.label}</button>)}</div>
    {kind === "agent" && <>
      <label className="field-label">Agent<select value={currentQueue?.config.memberIds[0] ?? ""} onChange={event => { const member = members.find(item => item.user_id === event.target.value); if (!member) return; const existing = queues.find(queue => queue.config.memberIds.length === 1 && queue.config.memberIds[0] === member.user_id); onChange({ type: "queue", queueId: existing?.id ?? onNewQueue(member.display_name, [member.user_id]) }); }}><option value="">Choisir un agent</option>{members.map(member => <option key={member.user_id} value={member.user_id}>{member.display_name}</option>)}</select></label>
      {!members.length && <p className="ivr-help">Attribuez le droit Appels sur ce numéro à un utilisateur dans l’administration.</p>}
      {currentQueue && <p className="ivr-help">L’agent recevra l’appel lorsqu’il sera disponible dans sa file.</p>}
    </>}
    {kind === "queue" && <>
      <label className="field-label">File d’attente<select value={value.type === "queue" ? value.queueId : ""} onChange={event => { if (event.target.value === "new") onChange({ type: "queue", queueId: onNewQueue("Nouvelle file", []) }); else onChange({ type: "queue", queueId: event.target.value }); }}><option value="">Choisir une file</option>{queues.map(queue => <option key={queue.id} value={queue.id}>{queue.config.name}</option>)}<option value="new">+ Créer une file</option></select></label>
      {currentQueue && localIds.includes(currentQueue.id) && <div className="ivr-inline-queue"><label className="field-label">Nom de la file<input maxLength={80} value={currentQueue.config.name} onChange={event => onEditQueue(currentQueue.id, { name: event.target.value })}/></label><span className="field-label">Agents de la file</span>{members.map(member => <label className="ivr-toggle" key={member.user_id}><input type="checkbox" checked={currentQueue.config.memberIds.includes(member.user_id)} onChange={event => onEditQueue(currentQueue.id, { memberIds: event.target.checked ? [...currentQueue.config.memberIds, member.user_id] : currentQueue.config.memberIds.filter(id => id !== member.user_id) })}/>{member.display_name}</label>)}{!members.length && <p className="ivr-help">Aucun utilisateur n’a le droit Appels sur ce numéro.</p>}</div>}
      {currentQueue && !localIds.includes(currentQueue.id) && <p className="ivr-help">{currentQueue.config.memberIds.length} agent(s) · attente maximale {currentQueue.config.maxWaitSeconds} s. Réglages disponibles dans Files d’attente.</p>}
    </>}
    {(kind === "agent" || kind === "queue") && currentQueue && localIds.includes(currentQueue.id) && <details className="ivr-details"><summary>Attente et débordement</summary><label className="field-label">Attente maximale (secondes)<input type="number" min={15} max={3600} value={currentQueue.config.maxWaitSeconds} onChange={event => onEditQueue(currentQueue.id, { maxWaitSeconds: Number(event.target.value) })}/></label><label className="field-label">Sonnerie par agent (secondes)<input type="number" min={5} max={60} value={currentQueue.config.ringTimeout} onChange={event => onEditQueue(currentQueue.id, { ringTimeout: Number(event.target.value) })}/></label><p className="ivr-help">Sans agent disponible à la fin de l’attente, l’appel passe en messagerie. Les annonces et le débordement se règlent aussi dans Files d’attente.</p></details>}
    {value.type === "number" && <label className="field-label">Numéro de destination<input type="tel" autoFocus placeholder="+33123456789" value={value.number} onChange={event => onChange({ type: "number", number: event.target.value.replace(/[\s().-]/g, "") })}/><small>Utilisez le format international avec +.</small></label>}
    {value.type === "menu" && <><button type="button" className="button button-secondary" onClick={() => onOpenMenu(value.menuId)}>Modifier les branches<ArrowRight/></button><label className="field-label">Menu de destination<select value={value.menuId} onChange={event => onChange({ type: "menu", menuId: event.target.value })}>{menus.map(menu => <option key={menu.id} value={menu.id}>{menu.name}</option>)}</select></label></>}
    {value.type === "voicemail" && <p className="ivr-help">L’appelant laisse un message. Vous le retrouvez dans Messages vocaux.</p>}
    {value.type === "hangup" && <p className="ivr-help">Un message d’au revoir est lu, puis l’appel se termine.</p>}
  </div>;
}
