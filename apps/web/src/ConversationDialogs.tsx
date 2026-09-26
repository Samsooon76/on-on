import { useState, type ReactNode } from "react";
import { ArrowRight, Backspace, ChatCircle, Microphone, MicrophoneSlash, Phone, PhoneDisconnect, PhoneX } from "@phosphor-icons/react";
import { normalizePhoneNumber } from "@onoff/contracts";
import type { ApiPage } from "@onoff/api-client";
import { useContacts } from "./useContacts";
import { Avatar, Modal } from "./ui";
import { formatPhone, type Contact } from "./conversation-model";

export function NewConversation({ scope, loadContacts, onOpen, onClose }: { scope: string; loadContacts(query: string, cursor: string | null, signal: AbortSignal): Promise<ApiPage<Contact>>; onOpen(number: string): void; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const directory = useContacts(scope, query, loadContacts);
  const matches = directory.contacts;
  return <Modal title="Nouvelle conversation" onClose={onClose}>
    <p className="modal-description">Choisissez un contact ou saisissez un numéro.</p>
    <form onSubmit={(event) => { event.preventDefault(); const number = normalizePhoneNumber(query); if (number) onOpen(number); else setError("Choisissez un contact ou saisissez un numéro valide, par exemple +33 6 12 34 56 78."); }}>
      <label className="field-label">À<input autoFocus value={query} onChange={(event) => { setQuery(event.target.value); setError(""); }} placeholder="Nom ou numéro de téléphone" maxLength={80} autoComplete="off" /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="recipient-list">{matches.flatMap((contact) => contact.contact_phones.map((phone) => <button type="button" key={phone.id} onClick={() => onOpen(phone.phone_number)}><Avatar name={contact.display_name} /><span><b>{contact.display_name}</b><small>{formatPhone(phone.phone_number)}</small></span><ArrowRight size={18} /></button>))}</div>
      {directory.state === "loading" && <p role="status">Recherche des contacts…</p>}
      {directory.error && <p className="form-error" role="alert">{directory.error} <button type="button" className="text-button" onClick={() => void directory.refresh()}>Réessayer</button></p>}
      {directory.hasMore && <button type="button" className="load-more" disabled={directory.loadingMore} onClick={() => void directory.more()}>Voir les contacts suivants</button>}
      <button className="button button-primary button-wide" type="submit" disabled={!query.trim()}><ChatCircle size={18} />Ouvrir la conversation</button>
    </form>
  </Modal>;
}

export function CallDialog(props: {
  number: string; name: string | null; line: string; status: string;
  state: "idle" | "connecting" | "ringing" | "active"; incoming: string; muted: boolean;
  enabled: boolean; busy: boolean; transcript?: ReactNode;
  onNumber(number: string): void; onClose(): void; onCall(): void; onAccept(): void;
  onReject(): void; onHangup(): void; onMute(): void; onDigit(digit: string): void;
}) {
  const active = props.state !== "idle" || Boolean(props.incoming);
  const [keypadOpen, setKeypadOpen] = useState(false);
  return <Modal title={props.incoming ? "Appel entrant" : active ? "Votre appel" : "Nouvel appel"} onClose={props.onClose} className={`call-dialog${props.transcript ? " has-transcript" : ""}`}><div className="call-dialog-layout"><div className="call-console">
    {active ? <div className="call-party"><Avatar name={props.name ?? (props.incoming || props.number)} large /><h3>{props.name ?? formatPhone(props.incoming || props.number)}</h3><p role="status">{props.status}</p></div> : <><p className="modal-description">Depuis votre ligne {formatPhone(props.line)}</p><label className="field-label">Numéro de téléphone<div className="dial-input"><input autoFocus inputMode="tel" value={props.number} onChange={(event) => props.onNumber(event.target.value)} placeholder="+33 6 12 34 56 78" /><button className="icon-button" type="button" aria-label="Effacer le dernier chiffre" onClick={() => props.onNumber(props.number.slice(0, -1))}><Backspace size={20} /></button></div></label>{props.name && <p className="dial-contact">{props.name}</p>}</>}
    {!props.incoming && (!props.transcript || keypadOpen) && <div className="dial-pad" role="group" aria-label="Clavier téléphonique">{['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((digit, index) => <button key={digit} type="button" disabled={active && props.state !== "active"} aria-label={props.state === "active" ? `Envoyer la tonalité ${digit}` : `Ajouter ${digit} au numéro`} onClick={() => props.state === "active" ? props.onDigit(digit) : props.onNumber(props.number + digit)}>{digit}<small>{['', 'ABC', 'DEF', 'GHI', 'JKL', 'MNO', 'PQRS', 'TUV', 'WXYZ', '', '+', ''][index]}</small></button>)}</div>}
    {props.incoming ? <div className="call-controls"><button className="button button-danger" onClick={props.onReject}><PhoneX size={19} />Refuser</button><button className="button button-primary" onClick={props.onAccept}><Phone size={19} />Répondre</button></div> : active ? <div className="call-controls">{props.state === "active" && <button className="button button-secondary" aria-pressed={props.muted} onClick={props.onMute}>{props.muted ? <MicrophoneSlash size={19} /> : <Microphone size={19} />}{props.muted ? "Rétablir" : "Couper le micro"}</button>}<button className="button button-danger" onClick={props.onHangup}><PhoneDisconnect size={19} />{props.state === "active" ? "Raccrocher" : "Annuler l’appel"}</button></div> : <button className="button button-primary button-wide" disabled={!props.enabled || props.busy || !normalizePhoneNumber(props.number)} onClick={props.onCall}><Phone size={19} />{props.busy ? "Préparation…" : "Appeler"}</button>}
    {props.transcript && <button className="text-button" aria-expanded={keypadOpen} onClick={() => setKeypadOpen(!keypadOpen)}>{keypadOpen ? "Masquer le clavier" : "Ouvrir le clavier"}</button>}
    {!active && <p className="dial-status" role="status">{props.status}</p>}
    </div>{props.transcript}</div>
  </Modal>;
}
