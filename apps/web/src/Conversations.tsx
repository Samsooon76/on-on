import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, ChatCircle, Check, Checks, Info, MagnifyingGlass, Phone, PhoneIncoming, PhoneOutgoing, PhoneX, Plus, UserPlus, X } from "@phosphor-icons/react";
import { Avatar, EmptyState } from "./ui";
import { buildTimeline, callLabel, formatDuration, formatPhone, isMissedCall, messageStatus, phoneKey, type Contact, type InboxConversation, type MessageRecord } from "./conversation-model";

type Props = {
  inbox: InboxConversation[];
  contacts: Contact[];
  number: string;
  lineNumber: string;
  messages: MessageRecord[];
  body: string;
  dataState: "loading" | "ready" | "error";
  messagesState: "loading" | "ready" | "error";
  busy: boolean;
  locked: boolean;
  pending: boolean;
  canSms: boolean;
  smsUnavailable: string;
  canCall: boolean;
  segments: number;
  hasMore: boolean;
  hasOlderMessages: boolean;
  loadingMore: boolean;
  onMore(): void;
  onOlderMessages(): void;
  onOpen(number: string, id: string | null): void;
  onNew(): void;
  onBack(): void;
  onBody(body: string): void;
  onSend(event: React.FormEvent): void;
  onCall(number: string): void;
  onAddContact(number: string): void;
  onRetry(): void;
};

function dayLabel(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Aujourd’hui";
  today.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Hier";
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) }).format(date);
}
const timeLabel = (value: string) => new Date(value).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
function inboxTime(value: string | null): string {
  if (!value) return "";
  return new Date(value).toDateString() === new Date().toDateString() ? timeLabel(value) : new Date(value).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

export function Conversations(props: Props) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "unread" | "missed">("all");
  const [eventFilter, setEventFilter] = useState<"all" | "message" | "call">("all");
  const [details, setDetails] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selected = props.inbox.find((thread) => phoneKey(thread.remoteNumber) === phoneKey(props.number));
  const matchingContacts = props.contacts.filter((contact) => contact.contact_phones.some((phone) => phoneKey(phone.phone_number) === phoneKey(props.number)));
  const contact = matchingContacts.length === 1 ? matchingContacts[0] : null;
  const name = selected?.name ?? contact?.display_name ?? formatPhone(props.number);
  const timeline = useMemo(() => buildTimeline(props.messages, selected?.calls ?? []), [props.messages, selected]);
  const visibleEvents = timeline.filter((event) => eventFilter === "all" || event.kind === eventFilter);
  const unread = props.inbox.filter((thread) => thread.unread).length;
  const filtered = props.inbox.filter((thread) => {
    const matchesSearch = `${thread.name ?? ""} ${thread.remoteNumber} ${thread.preview}`.toLocaleLowerCase("fr").includes(search.toLocaleLowerCase("fr")) || (search.replace(/\D/g, "").length > 2 && phoneKey(thread.remoteNumber).includes(search.replace(/\D/g, "")));
    return matchesSearch && (filter === "all" || (filter === "unread" ? thread.unread : thread.hasMissedCall));
  });
  const newestEventId = visibleEvents.at(-1)?.id;
  useEffect(() => { setEventFilter("all"); setDetails(false); }, [props.number]);
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [props.number, newestEventId, eventFilter]);

  return <div className={`conversation-workspace${props.number ? " has-thread" : ""}${details ? " has-details" : ""}`}>
    <aside className="inbox-panel" aria-label="Liste des conversations">
      <div className="inbox-heading"><div><h2>Boîte de réception</h2><span>{unread ? `${unread} non lue${unread > 1 ? "s" : ""}` : "Tous vos échanges"}</span></div><button className="icon-button" onClick={props.onNew} disabled={props.locked || !props.lineNumber} title="Nouvelle conversation" aria-label="Nouvelle conversation"><Plus /></button></div>
      <label className="search-field"><MagnifyingGlass size={17} /><input aria-label="Rechercher une conversation" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Rechercher une conversation" /></label>
      <div className="inbox-filters" role="group" aria-label="Filtrer les conversations">
        {([['all', 'Toutes'], ['unread', 'Non lues'], ['missed', 'Manqués']] as const).map(([value, label]) => <button key={value} aria-pressed={filter === value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}{value === "unread" && unread > 0 && <span>{unread}</span>}</button>)}
      </div>
      <div className="inbox-list" aria-busy={props.dataState === "loading"}>
        {filtered.map((thread) => <button key={thread.key} className={`inbox-row${phoneKey(thread.remoteNumber) === phoneKey(props.number) ? " selected" : ""}${thread.unread ? " unread" : ""}`} disabled={props.locked || !props.lineNumber} aria-pressed={phoneKey(thread.remoteNumber) === phoneKey(props.number)} onClick={() => props.onOpen(thread.remoteNumber, thread.smsConversationId)}>
          <Avatar name={thread.name ?? thread.remoteNumber} />
          <span className="inbox-row-content"><span className="inbox-row-title"><b>{thread.name ?? formatPhone(thread.remoteNumber)}</b><time dateTime={thread.updatedAt ?? undefined}>{inboxTime(thread.updatedAt)}</time></span><span className="inbox-preview">{thread.lastKind === "call" && <Phone size={13} />}<span>{thread.preview}</span>{thread.unread && <i className="unread-dot" aria-label="Non lue" />}</span></span>
        </button>)}
        {!filtered.length && <EmptyState icon={<ChatCircle size={25} />} title={props.dataState === "loading" ? "Chargement…" : props.dataState === "error" ? "Chargement impossible" : search || filter !== "all" ? "Aucune conversation trouvée" : "Votre boîte de réception est prête"}>
          <p>{props.dataState === "error" ? "Vos échanges n’ont pas pu être récupérés." : search || filter !== "all" ? "Essayez une autre recherche ou un autre filtre." : "Vos SMS et appels se retrouvent ici, par interlocuteur."}</p>
          {props.dataState === "error" ? <button className="text-button" onClick={props.onRetry}>Réessayer</button> : !search && filter === "all" && props.dataState === "ready" && <button className="text-button" disabled={props.locked || !props.lineNumber} onClick={props.onNew}>Démarrer une conversation</button>}
        </EmptyState>}
        {props.hasMore && <button className="load-more" disabled={props.loadingMore} onClick={props.onMore}>{props.loadingMore ? "Chargement…" : "Voir les échanges précédents"}</button>}
      </div>
      <div className="inbox-footer"><ChatCircle size={15} /><span>{props.inbox.length}{props.hasMore ? "+" : ""} conversation{props.inbox.length > 1 ? "s" : ""} · SMS et appels</span></div>
    </aside>

    <section className="thread-panel" aria-label="Conversation">
      {props.number ? <>
        <header className="thread-header">
          <button className="icon-button mobile-back" aria-label="Retour aux conversations" disabled={props.locked || !props.lineNumber} onClick={props.onBack}><ArrowLeft /></button>
          <Avatar name={name} />
          <div className="thread-identity"><h2>{name}</h2><span>{name === formatPhone(props.number) ? "Conversation" : formatPhone(props.number)}</span></div>
          <div className="thread-actions"><button className="button button-secondary thread-call" disabled={!props.canCall} onClick={() => props.onCall(props.number)} title="Appeler cet interlocuteur"><Phone size={18} /><span>Appeler</span></button><button className={`icon-button${details ? " selected" : ""}`} aria-label="Détails de la conversation" aria-expanded={details} onClick={() => setDetails(!details)}><Info /></button></div>
        </header>
        <div className="thread-toolbar"><div className="thread-tabs" role="group" aria-label="Type d’échanges">{([['all', 'Tout'], ['message', 'SMS'], ['call', 'Appels']] as const).map(([value, label]) => <button key={value} aria-pressed={eventFilter === value} className={eventFilter === value ? "active" : ""} onClick={() => setEventFilter(value)}>{label}</button>)}</div><span className="thread-line">via {formatPhone(props.lineNumber)}</span></div>
        <div className="timeline" ref={scrollRef} tabIndex={0} aria-label="Historique des échanges" aria-busy={props.messagesState === "loading"}>
          {props.hasOlderMessages && eventFilter !== "call" && <button className="load-more" onClick={props.onOlderMessages} disabled={props.loadingMore}>{props.loadingMore ? "Chargement…" : "Messages précédents"}</button>}
          {props.messagesState === "loading" && <p className="timeline-status" role="status">Chargement des messages…</p>}
          {props.messagesState === "error" && <div className="inline-warning" role="alert">Les messages n’ont pas pu être chargés. <button className="text-button" onClick={props.onRetry}>Réessayer</button></div>}
          {visibleEvents.map((event, index) => <Fragment key={event.id}>
            {(index === 0 || new Date(event.createdAt).toDateString() !== new Date(visibleEvents[index - 1]!.createdAt).toDateString()) && <div className="date-divider"><span>{dayLabel(event.createdAt)}</span></div>}
            {event.kind === "message" ? <div className={`message-event ${event.message.direction}`}>
              <div className={`message-bubble${['failed', 'undelivered'].includes(event.message.status) ? " message-failed" : ""}`}><p>{event.message.body}</p></div>
              <div className="message-meta"><time dateTime={event.createdAt}>{timeLabel(event.createdAt)}</time>{event.message.direction === "outbound" && <><span>{messageStatus(event.message.status)}</span>{event.message.status === "delivered" ? <Checks size={14} /> : event.message.status === "sent" ? <Check size={14} /> : null}</>}</div>
            </div> : <div className={`call-event${isMissedCall(event.call) ? " missed" : ""}`}>
              <span className="call-event-icon">{isMissedCall(event.call) ? <PhoneX /> : event.call.direction === "inbound" ? <PhoneIncoming /> : <PhoneOutgoing />}</span>
              <div><b>{callLabel(event.call)}</b><p>{event.call.duration_seconds ? formatDuration(event.call.duration_seconds) : ['answered', 'ringing', 'initiated'].includes(event.call.status) ? "En cours" : event.call.status === "completed" ? "Terminé" : "Non abouti"}<span>·</span><time dateTime={event.createdAt}>{timeLabel(event.createdAt)}</time></p></div>
              <button className="icon-button" disabled={!props.canCall} aria-label={`Rappeler ${name}`} title="Rappeler" onClick={() => props.onCall(props.number)}><Phone size={18} /></button>
            </div>}
          </Fragment>)}
          {!visibleEvents.length && props.messagesState === "ready" && <EmptyState icon={eventFilter === "call" ? <Phone size={25} /> : <ChatCircle size={25} />} title={eventFilter === "call" ? "Aucun appel dans cet historique" : eventFilter === "message" ? "Pas encore de SMS" : "Le début de votre conversation"}><p>{eventFilter === "call" ? "Les appels avec cet interlocuteur apparaîtront ici." : `Écrivez à ${name} pour commencer l’échange.`}</p></EmptyState>}
        </div>
        <div className="composer-container">
          {props.pending && <p className="inline-warning" role="status">L’envoi précédent est à vérifier. Votre message est conservé.</p>}
          <form className="composer" onSubmit={props.onSend}>
            <label className="composer-label" htmlFor="sms-message"><ChatCircle size={15} />SMS<span>{props.canSms ? "" : props.smsUnavailable}</span></label>
            <textarea id="sms-message" value={props.body} onChange={(event) => props.onBody(event.target.value)} maxLength={1600} rows={2} disabled={props.locked || !props.canSms} placeholder={props.canSms ? `Écrire à ${name}…` : props.smsUnavailable} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !props.busy && !props.locked && props.canSms && props.body.trim()) event.currentTarget.form?.requestSubmit(); }} />
            <div className="composer-footer"><span className={!props.body.length ? "keyboard-hint" : undefined}>{props.body.length ? `${props.body.length}/1600 · ${props.segments} SMS estimé${props.segments > 1 ? "s" : ""}` : "⌘ / Ctrl + Entrée pour envoyer"}</span><button className="button button-primary send-button" disabled={props.busy || (!props.pending && props.locked) || !props.body.trim() || !props.canSms} type="submit">{props.busy ? "En cours…" : props.pending ? "Vérifier l’envoi" : "Envoyer"}<ArrowUp size={17} /></button></div>
          </form>
          <p className="composer-note">{props.canSms ? `Envoyé depuis le ${formatPhone(props.lineNumber)}` : props.smsUnavailable}</p>
        </div>
      </> : <div className="thread-welcome"><div className="welcome-symbol"><ChatCircle size={40} weight="thin" /></div><h2>Choisissez une conversation.</h2><p>Retrouvez les messages et les appels d’un interlocuteur,<br />ou commencez un nouvel échange.</p><button className="button button-primary" disabled={props.locked || !props.lineNumber} onClick={props.onNew}><Plus size={17} />Nouvelle conversation</button><div className="welcome-formats"><span><ChatCircle size={16} />SMS</span><span><Phone size={16} />Appels</span></div></div>}
    </section>

    {details && props.number && <aside className="conversation-details" aria-label="Détails du contact">
      <div className="details-heading"><h3>Détails</h3><button className="icon-button" aria-label="Fermer les détails" onClick={() => setDetails(false)}><X size={18} /></button></div>
      <div className="details-profile"><Avatar name={name} large /><h3>{name}</h3><span>{formatPhone(props.number)}</span>{!contact && <button className="text-button" onClick={() => props.onAddContact(props.number)}><UserPlus size={16} />Ajouter aux contacts</button>}</div>
      <dl className="details-facts"><div><dt>Téléphone</dt><dd>{formatPhone(props.number)}</dd></div>{contact?.email && <div><dt>Email</dt><dd>{contact.email}</dd></div>}<div><dt>Votre ligne</dt><dd>{formatPhone(props.lineNumber)}</dd></div></dl>
      <div className="details-resources"><h4>Dans cette conversation</h4><button onClick={() => { setEventFilter("message"); setDetails(false); }}><ChatCircle size={18} />Messages <span>{props.messages.length}{props.hasOlderMessages ? "+" : ""}</span></button><button onClick={() => { setEventFilter("call"); setDetails(false); }}><Phone size={18} />Appels <span>{selected?.calls.length ?? 0}</span></button></div>
    </aside>}
  </div>;
}
