import { useEffect, useReducer, useRef, useState } from "react";
import { ArrowRight, Check, CheckCircle, DownloadSimple, Headset, Lightning, ListNumbers, MagnifyingGlass, Microphone, MicrophoneSlash, Pause, Phone, PhoneDisconnect, Play, Plus, SkipForward, Tag, Trash, X } from "@phosphor-icons/react";
import type { VoiceEvent } from "@onoff/voice-contract";
import { Avatar, EmptyState, Modal } from "./ui";
import { callLabel, formatPhone, phoneKey, type CallRecord, type Contact } from "./conversation-model";
import { dialerContacts, dialerReducer, initialDialerState, isDialing, outcomes, type DialerContact, type Outcome } from "./powerdialer-model";
import "./powerdialer.css";

type ContactPage = { items: Contact[]; nextCursor: string | null };
type Props = {
  visible: boolean;
  lineNumber: string;
  scope: { userId: string; organizationId: string; lineId: string };
  enabled: boolean;
  blocked: boolean;
  voiceStatus: string;
  voiceState: "idle" | "connecting" | "ringing" | "active";
  muted: boolean;
  calls: CallRecord[];
  loadContacts(query: string, cursor?: string): Promise<ContactPage>;
  onStart(number: string, shouldContinue: () => boolean): Promise<string>;
  onHangup(): void;
  onMute(): void;
  onDigits(digits: string): void;
  subscribe(listener: (event: VoiceEvent) => void): () => void;
  onLock(locked: boolean): void;
};

export function PowerDialer(props: Props) {
  const [state, dispatch] = useReducer(dialerReducer, initialDialerState);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [delay, setDelay] = useState(5);
  const [keypadOpen, setKeypadOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const starting = useRef(false);
  const queueRef = useRef<HTMLOListElement>(null);
  const currentRef = useRef({ state, props, autoAdvance, delay });
  currentRef.current = { state, props, autoAdvance, delay };
  const entry = state.entries.find((item) => item.id === state.activeId);
  const pending = state.entries.filter((item) => item.status === "pending").length;
  const completed = state.entries.filter((item) => item.status === "done");
  const skipped = state.entries.filter((item) => item.status === "skipped").length;
  const dialing = isDialing(state);
  const locked = dialing || state.phase === "wrapup" || state.phase === "between" || state.running;
  const canStart = props.enabled && !props.blocked && props.voiceState === "idle" && !starting.current;
  const latestCall = entry ? props.calls.filter((call) => phoneKey(call.remote_number) === phoneKey(entry.number)).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] : undefined;

  useEffect(() => {
    if (!props.visible) return;
    const queue = queueRef.current;
    if (!queue) return;
    const revealCurrent = () => {
      const current = queue.querySelector<HTMLElement>('[aria-current="step"]');
      if (!current) return;
      const list = queue.getBoundingClientRect();
      const item = current.getBoundingClientRect();
      if (queue.scrollWidth > queue.clientWidth) queue.scrollLeft += item.left - list.left - 9;
      else if (item.top < list.top) queue.scrollTop += item.top - list.top;
      else if (item.bottom > list.bottom) queue.scrollTop += item.bottom - list.bottom;
    };
    revealCurrent();
    const observer = new ResizeObserver(revealCurrent);
    observer.observe(queue);
    return () => observer.disconnect();
  }, [state.activeId, props.visible]);

  useEffect(() => { setKeypadOpen(false); }, [state.activeId]);

  useEffect(() => { props.onLock(locked); return () => props.onLock(false); }, [locked, props.onLock]);

  useEffect(() => props.subscribe((event) => {
    const current = currentRef.current;
    if (event.type === "incoming" || event.type === "unavailable" || event.type === "reconnecting") {
      dispatch({ type: "pause", message: event.type === "incoming" ? "Session en pause pendant l’appel entrant." : "Session en pause : vérifiez la connexion vocale." });
    }
    if (event.type === "ended") dispatch({ type: "ended", at: new Date().toISOString(), delay: current.autoAdvance ? current.delay : 0, failed: event.reason === "failed" });
  }), [props.subscribe]);

  useEffect(() => {
    if (!props.visible || !props.enabled || props.blocked || pickerOpen || summaryOpen) dispatch({ type: "pause" });
  }, [props.visible, props.enabled, props.blocked, pickerOpen, summaryOpen]);

  useEffect(() => {
    const pauseWhenHidden = () => { if (document.hidden) dispatch({ type: "pause" }); };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, []);

  useEffect(() => {
    if (!state.entries.some((item) => item.attemptedAt || item.notes)) return;
    const protectSession = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protectSession);
    return () => window.removeEventListener("beforeunload", protectSession);
  }, [state.entries]);

  useEffect(() => {
    if (state.phase !== "between" || !state.running || !props.visible || !props.enabled || props.blocked || pickerOpen || summaryOpen) return;
    if (state.remaining === 0) { void start(); return; }
    const timeout = window.setTimeout(() => dispatch({ type: "tick" }), 1000);
    return () => window.clearTimeout(timeout);
  }, [state.phase, state.running, state.remaining, props.visible, props.enabled, props.blocked, pickerOpen, summaryOpen]);

  useEffect(() => {
    if (!dialing || !entry?.attemptedAt) { setElapsed(0); return; }
    const began = new Date(entry.attemptedAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - began) / 1000));
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [dialing, entry?.attemptedAt]);

  async function start() {
    const { state: current, props: latest } = currentRef.current;
    const next = current.entries.find((item) => item.id === current.activeId);
    if (starting.current || !next || !["ready", "between"].includes(current.phase) || !latest.enabled || latest.blocked || latest.voiceState !== "idle" || !latest.visible || document.hidden) return;
    starting.current = true;
    dispatch({ type: "start", at: new Date().toISOString() });
    try {
      const intentId = await latest.onStart(next.number, () => { const latest = currentRef.current; return latest.state.running && latest.props.visible && latest.props.enabled && !latest.props.blocked && !document.hidden; });
      dispatch({ type: "started", id: next.id, intentId });
    } catch (error) {
      dispatch({ type: "failed", message: error instanceof Error ? error.message : "L’appel n’a pas pu démarrer. Réessayez lorsque la ligne est disponible." });
    } finally { starting.current = false; }
  }

  function qualify(outcome: Outcome) {
    const current = currentRef.current;
    if (!["calling", "wrapup"].includes(current.state.phase)) return;
    dispatch({ type: "qualify", outcome, delay: current.autoAdvance ? current.delay : 0, at: new Date().toISOString() });
    if (current.state.phase === "calling") current.props.onHangup();
  }

  const actions = useRef({ start, qualify });
  actions.current = { start, qualify };
  useEffect(() => {
    if (!props.visible || pickerOpen || summaryOpen) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || target?.closest("input, textarea, select, a, [contenteditable=true], dialog") || document.querySelector("dialog[open]")) return;
      const current = currentRef.current.state;
      const outcome = outcomes.find((item) => item.key === event.key);
      if (outcome && ["calling", "wrapup"].includes(current.phase)) { event.preventDefault(); actions.current.qualify(outcome.id); }
      else if (event.code === "Space") {
        if (target?.closest("button")) return;
        event.preventDefault();
        if (current.running) dispatch({ type: "pause" });
        else if (current.phase === "ready") void actions.current.start();
      } else if (event.key === "Escape") dispatch({ type: "pause" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.visible, pickerOpen, summaryOpen]);

  function exportSession() {
    const blob = new Blob([JSON.stringify({ schemaVersion: 1, ...props.scope, exportedAt: new Date().toISOString(), entries: state.entries }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `onoff-powerdialer-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const stateLabel = state.phase === "starting" ? "Préparation de l’appel…" : state.phase === "ending" ? "Fin de l’appel…" : state.phase === "calling" ? props.voiceStatus : state.phase === "wrapup" ? "Appel terminé · à qualifier" : state.phase === "between" ? `Prochain appel dans ${state.remaining} s` : "Prêt à appeler";

  return <section className="powerdialer" hidden={!props.visible} aria-label="Powerdialer">
    <header className="pd-header">
      <div><div className="pd-title"><Lightning size={21} weight="duotone" /><h2>Gardez le rythme.</h2></div><p>Une file de contacts. Une conversation à la fois.</p></div>
      <div className="pd-header-actions">{state.entries.length > 0 && <button className="button button-secondary" onClick={() => { dispatch({ type: "pause" }); setSummaryOpen(true); }}><ListNumbers size={16} />Bilan de session</button>}<button className="button button-primary" onClick={() => { dispatch({ type: "pause" }); setPickerOpen(true); }} disabled={!props.scope.organizationId}><Plus size={17} />Ajouter des contacts</button></div>
    </header>
    {!state.entries.length ? <div className="pd-onboarding">
      <span className="pd-start-icon"><Headset size={42} weight="light" /></span>
      <h3>Moins de clics.<br />Plus de conversations.</h3>
      <p>Préparez votre liste, lancez le premier appel.<br />Un résultat suffit pour passer au suivant.</p>
      <button className="button button-primary" onClick={() => setPickerOpen(true)} disabled={!props.scope.organizationId}><Plus size={17} />Créer ma file d’appels</button>
      <div className="pd-steps"><span><b>1</b>Sélectionnez vos contacts</span><span><b>2</b>Appelez et prenez des notes</span><span><b>3</b>Qualifiez, puis enchaînez</span></div>
    </div> : <>
      <div className="pd-session-bar">
        <span className={`pd-session-status${state.running ? " is-running" : ""}`}><i />{state.phase === "complete" ? "Session terminée" : state.running ? "Session en cours" : state.entries.some((item) => item.attemptedAt) ? "Session en pause" : "Session prête"}</span>
        <span><strong>{completed.length}</strong> / {state.entries.length} traités{skipped > 0 ? ` · ${skipped} ignoré${skipped > 1 ? "s" : ""}` : ""}</span>
        <span className="pd-session-line"><Phone size={13} />{props.lineNumber ? formatPhone(props.lineNumber) : "Aucune ligne"}</span>
        <label className="pd-auto"><input type="checkbox" checked={autoAdvance} onChange={(event) => { setAutoAdvance(event.target.checked); if (!event.target.checked) dispatch({ type: "pause" }); }} />Enchaînement auto</label>
        <label className="pd-delay">Délai<select aria-label="Délai entre les appels" disabled={!autoAdvance} value={delay} onChange={(event) => { setDelay(Number(event.target.value)); if (state.phase === "between") dispatch({ type: "pause" }); }}><option value={3}>3 s</option><option value={5}>5 s</option><option value={10}>10 s</option><option value={15}>15 s</option></select></label>
      </div>
      <div className="pd-workspace">
        <aside className="pd-queue" aria-label="File d’appels"><div className="pd-panel-heading"><h3>File d’appels</h3><span>{pending + (dialing || state.phase === "wrapup" ? 1 : 0)} restants</span></div>
          <ol ref={queueRef}>{state.entries.map((item, index) => <li key={item.id} className={`${item.id === state.activeId ? "is-current " : ""}${["done", "skipped"].includes(item.status) ? "is-done" : ""}`} aria-current={item.id === state.activeId ? "step" : undefined}>
            <span className="pd-queue-index">{item.status === "done" ? <Check size={15} /> : item.status === "skipped" ? <SkipForward size={14} /> : index + 1}</span>
            <div><strong>{item.name}</strong><span>{item.outcome ? outcomes.find((outcome) => outcome.id === item.outcome)?.label : item.status === "skipped" ? "Ignoré" : item.id === state.activeId && dialing ? "Appel en cours" : formatPhone(item.number)}</span></div>
            {item.id === state.activeId ? <span className="pd-current-indicator"><ArrowRight size={15} /></span> : null}
            {item.status === "pending" && !locked && <button className="icon-button" aria-label={`Retirer ${item.name} de la file`} onClick={() => dispatch({ type: "remove", id: item.id })}><X size={15} /></button>}
          </li>)}</ol>
          <button className="pd-add-more" onClick={() => { dispatch({ type: "pause" }); setPickerOpen(true); }}><Plus size={15} />Ajouter à la file</button>
        </aside>
        <div className="pd-focus">
          {entry ? <>
            <div className="pd-contact-heading"><span>CONTACT {state.entries.findIndex((item) => item.id === entry.id) + 1} SUR {state.entries.length}</span><button className="text-button" disabled={state.phase !== "ready"} onClick={() => dispatch({ type: "skip" })}>Ignorer<SkipForward size={14} /></button></div>
            <div className="pd-contact"><Avatar name={entry.name} large /><div><h3>{entry.name}</h3><p>{formatPhone(entry.number)}{entry.phoneLabel ? ` · ${entry.phoneLabel}` : ""}</p>{entry.email && <span>{entry.email}</span>}</div></div>
            <div className={`pd-call-status${dialing ? " is-live" : ""}`} role="status"><span><i />{stateLabel}</span>{dialing && <time aria-label="Temps depuis le lancement de l’appel">{Math.floor(elapsed / 60).toString().padStart(2, "0")}:{(elapsed % 60).toString().padStart(2, "0")}</time>}</div>
            {state.error && <p className="pd-error" role="alert">{state.error}</p>}
            {!props.enabled && <p className="pd-error">{props.lineNumber ? "La ligne vocale doit être disponible et le navigateur connecté pour appeler." : "Sélectionnez une ligne pour commencer les appels."}</p>}
            <div className="pd-context"><span>Dernier échange téléphonique</span><p>{latestCall ? `${callLabel(latestCall)} · ${new Date(latestCall.created_at).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}` : "Aucun appel dans l’historique chargé."}</p></div>
            <label className="pd-notes">Notes de l’appel<span>Facultatif · conservées dans cette session</span><textarea value={entry.notes} maxLength={5000} placeholder="Besoins, objections, prochaine étape…" onFocus={() => { if (state.phase === "between") dispatch({ type: "pause" }); }} onChange={(event) => dispatch({ type: "notes", id: entry.id, notes: event.target.value })} /></label>
            <section className="pd-qualification" aria-label="Résultat de l’appel"><div><h4><Tag size={16} />Résultat de l’appel</h4><span>{state.phase === "calling" ? "Un clic raccroche et passe au suivant" : "Un clic pour qualifier et continuer"}</span></div><div className="pd-outcomes">{outcomes.map((outcome) => <button key={outcome.id} disabled={!["calling", "wrapup"].includes(state.phase)} onClick={() => qualify(outcome.id)} aria-keyshortcuts={outcome.key}><span>{outcome.label}</span><kbd>{outcome.key}</kbd></button>)}</div>{entry.outcome && <p className="pd-result-saved"><Check size={14} />{outcomes.find((outcome) => outcome.id === entry.outcome)?.label} · résultat retenu</p>}</section>
          </> : <div className="pd-complete"><CheckCircle size={45} weight="light" /><h3>Votre file est terminée.</h3><p>{completed.length} appel{completed.length > 1 ? "s" : ""} qualifié{completed.length > 1 ? "s" : ""}{skipped ? ` · ${skipped} contact${skipped > 1 ? "s" : ""} ignoré${skipped > 1 ? "s" : ""}` : ""}</p><div className="pd-summary-counts">{outcomes.map((outcome) => <div key={outcome.id}><strong>{completed.filter((item) => item.outcome === outcome.id).length}</strong><span>{outcome.label}</span></div>)}</div><button className="button button-primary" onClick={exportSession}><DownloadSimple size={17} />Exporter le bilan et les notes</button><button className="text-button" onClick={() => setPickerOpen(true)}><Plus size={15} />Ajouter d’autres contacts</button></div>}
        </div>
      </div>
      <footer className="pd-controls">
        <div className="pd-control-copy"><strong>{state.phase === "between" ? `Le prochain appel démarre dans ${state.remaining} s` : state.phase === "wrapup" ? "Choisissez un résultat pour continuer" : dialing ? state.running && autoAdvance ? "L’appel suivant sera préparé après qualification" : "La session restera en pause après cet appel" : entry ? autoAdvance ? "Prêt pour le prochain appel" : "Enchaînement manuel" : "Session terminée"}</strong><span>{state.phase === "between" ? "Mettez en pause pour prendre votre temps." : "Notes et résultats locaux à cette session · Exportez le bilan pour les conserver."}</span></div>
        <div className="pd-control-actions">
          {state.running && <button className="button button-secondary" onClick={() => dispatch({ type: "pause" })}><Pause size={17} />Pause</button>}
          {state.phase === "calling" && <><button className={`icon-button pd-mute${props.muted ? " is-muted" : ""}`} aria-label={props.muted ? "Réactiver le microphone" : "Couper le microphone"} aria-pressed={props.muted} onClick={props.onMute}>{props.muted ? <MicrophoneSlash /> : <Microphone />}</button><button className="button button-secondary" onClick={() => setKeypadOpen(!keypadOpen)} aria-expanded={keypadOpen}>Clavier</button><button className="button pd-hangup" onClick={props.onHangup}><PhoneDisconnect size={18} />Raccrocher</button></>}
          {entry && ["ready", "between"].includes(state.phase) && <button className="button button-primary pd-start-call" disabled={!canStart} onClick={() => void start()}><Play size={17} weight="fill" />{state.phase === "between" ? "Appeler maintenant" : entry.attemptedAt ? "Réessayer l’appel" : completed.length || skipped ? "Appeler le suivant" : "Démarrer la session"}</button>}
          {["starting", "ending"].includes(state.phase) && <span className="pd-pending-action">{state.phase === "starting" ? "Connexion…" : "Fin de l’appel…"}</span>}
          {!entry && <button className="button button-secondary" onClick={() => setSummaryOpen(true)}>Voir le bilan<ArrowRight size={16} /></button>}
        </div>
        {keypadOpen && state.phase === "calling" && <div className="pd-keypad" aria-label="Clavier téléphonique">{"123456789*0#".split("").map((digit) => <button key={digit} onClick={() => props.onDigits(digit)} aria-label={`Touche ${digit}`}>{digit}</button>)}</div>}
      </footer>
      <div className="pd-shortcuts"><span><kbd>Espace</kbd> Démarrer / pause</span><span><kbd>1</kbd> à <kbd>5</kbd> Qualifier l’appel</span><span><kbd>Échap</kbd> Pause</span></div>
    </>}
    {pickerOpen && <ContactPicker loadContacts={props.loadContacts} existing={state.entries.map((item) => item.number)} onClose={() => setPickerOpen(false)} onAdd={(contacts) => { dispatch({ type: "add", contacts }); setPickerOpen(false); }} />}
    {summaryOpen && <Modal title="Bilan de session" className="pd-summary-modal" onClose={() => setSummaryOpen(false)}><p className="pd-modal-description">{completed.length} appels qualifiés · {skipped} contacts ignorés. Les notes et résultats sont conservés tant que cet espace reste ouvert.</p><div className="pd-summary-list">{state.entries.filter((item) => item.attemptedAt || item.notes || item.status === "skipped").map((item) => <article key={item.id}><div><strong>{item.name}</strong><span>{item.outcome ? outcomes.find((outcome) => outcome.id === item.outcome)?.label : item.status === "skipped" ? "Ignoré" : "Non qualifié"}</span></div><small>{formatPhone(item.number)}</small>{item.notes && <p>{item.notes}</p>}</article>)}{!completed.length && !state.entries.some((item) => item.notes || item.attemptedAt || item.status === "skipped") && <p className="pd-modal-description">Les résultats de vos appels apparaîtront ici.</p>}</div><div className="modal-actions"><button className="button button-secondary" disabled={dialing || state.phase === "wrapup"} onClick={() => { exportSession(); dispatch({ type: "reset" }); setSummaryOpen(false); }}><Trash size={16} />Exporter et vider la file</button><button className="button button-primary" onClick={exportSession}><DownloadSimple size={16} />Exporter</button></div></Modal>}
  </section>;
}

function ContactPicker({ loadContacts, existing, onClose, onAdd }: { loadContacts: Props["loadContacts"]; existing: string[]; onClose(): void; onAdd(contacts: DialerContact[]): void }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<DialerContact[]>([]);
  const [selected, setSelected] = useState<Map<string, DialerContact>>(new Map());
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState("");
  const [retry, setRetry] = useState(0);
  const request = useRef(0);
  const loader = useRef(loadContacts); loader.current = loadContacts;
  useEffect(() => {
    const version = ++request.current;
    setStatus("loading"); setLoadingMore(false); setMoreError(""); setItems([]); setCursor(null);
    const timer = window.setTimeout(() => {
      void loader.current(query).then((page) => {
        if (version !== request.current) return;
        setItems(dialerContacts(page.items)); setCursor(page.nextCursor); setStatus("ready");
      }).catch(() => { if (version === request.current) setStatus("error"); });
    }, 200);
    return () => { window.clearTimeout(timer); request.current++; };
  }, [query, retry]);
  const available = items.filter((item) => !existing.includes(item.number));
  const allSelected = available.length > 0 && available.every((item) => selected.has(item.number));
  async function loadMore() {
    if (!cursor || loadingMore) return;
    const version = request.current; setLoadingMore(true); setMoreError("");
    try {
      const page = await loader.current(query, cursor);
      if (version !== request.current) return;
      setItems((current) => [...new Map([...current, ...dialerContacts(page.items)].map((item) => [item.number, item])).values()]); setCursor(page.nextCursor);
    } catch { if (version === request.current) setMoreError("Chargement impossible. Réessayez."); }
    finally { if (version === request.current) setLoadingMore(false); }
  }
  return <Modal title="Ajouter à la file d’appels" className="pd-picker" onClose={onClose}>
    <p className="pd-modal-description">Choisissez les contacts à appeler, dans l’ordre de sélection. Les numéros déjà dans la file sont exclus.</p>
    <label className="search-field"><MagnifyingGlass size={18} /><input autoFocus type="search" placeholder="Rechercher un contact" aria-label="Rechercher dans le répertoire" maxLength={80} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="pd-picker-toolbar"><label><input type="checkbox" checked={allSelected} disabled={!available.length || status !== "ready"} onChange={() => setSelected((current) => { const next = new Map(current); for (const item of available) { if (allSelected) next.delete(item.number); else next.set(item.number, item); } return next; })} />Toute la liste affichée</label><span>{selected.size} sélectionné{selected.size > 1 ? "s" : ""}</span></div>
    <div className="pd-picker-list" aria-busy={status === "loading"}>
      {status === "loading" ? <p className="pd-modal-description" role="status">Chargement des contacts…</p> : status === "error" ? <EmptyState icon={<Phone />} title="Répertoire indisponible"><button className="text-button" onClick={() => setRetry(retry + 1)}>Réessayer</button></EmptyState> : items.length ? items.map((item) => <label className="pd-picker-row" key={item.id}><input type="checkbox" checked={selected.has(item.number)} disabled={existing.includes(item.number)} onChange={(event) => setSelected((current) => { const next = new Map(current); if (event.target.checked) next.set(item.number, item); else next.delete(item.number); return next; })} /><Avatar name={item.name} /><span><strong>{item.name}</strong><small>{formatPhone(item.number)}{item.phoneLabel ? ` · ${item.phoneLabel}` : ""}</small></span>{existing.includes(item.number) && <small>Déjà dans la file</small>}</label>) : <EmptyState icon={<MagnifyingGlass />} title="Aucun contact avec un numéro valide"><p>{query ? "Essayez un autre nom." : "Ajoutez des contacts avec un numéro dans votre répertoire."}</p></EmptyState>}
      {moreError && <p role="alert" className="pd-error">{moreError}</p>}{cursor && <button className="load-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Chargement…" : "Charger plus de contacts"}</button>}
    </div><div className="modal-actions"><button className="button button-secondary" onClick={onClose}>Annuler</button><button className="button button-primary" disabled={!selected.size} onClick={() => onAdd([...selected.values()])}>Ajouter {selected.size || "les"} contact{selected.size === 1 ? "" : "s"}<ArrowRight size={16} /></button></div>
  </Modal>;
}
