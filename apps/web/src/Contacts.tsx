import { Archive, ChatCircle, MagnifyingGlass, PencilSimple, Phone, Plus, Users } from "@phosphor-icons/react";
import { Avatar, EmptyState } from "./ui";
import { formatPhone, type Contact } from "./conversation-model";

export function Contacts(props: {
  contacts: Contact[]; search: string; busy: boolean; dataState: "loading" | "ready" | "error";
  onSearch(value: string): void; onAdd(): void; onEdit(contact: Contact): void;
  onArchive(contact: Contact): void; onCall(contact: Contact): void; onMessage(contact: Contact): void;
}) {
  return <section className="directory-page">
    <div className="section-intro"><div><h2>Votre répertoire partagé</h2><p>Les bonnes personnes, à portée de conversation.</p></div><button className="button button-primary" onClick={props.onAdd}><Plus size={17} />Ajouter un contact</button></div>
    <div className="directory-toolbar"><label className="search-field"><MagnifyingGlass size={18} /><input type="search" aria-label="Rechercher un contact" placeholder="Rechercher par nom" value={props.search} onChange={(event) => props.onSearch(event.target.value)} maxLength={80} /></label><span>{props.contacts.length} contact{props.contacts.length > 1 ? "s" : ""} affiché{props.contacts.length > 1 ? "s" : ""}</span></div>
    <div className="directory-list">
      {props.contacts.map((contact) => <article className="contact-row" key={contact.id}><Avatar name={contact.display_name} /><div className="contact-identity"><h3>{contact.display_name}</h3><span>{contact.contact_phones[0] ? formatPhone(contact.contact_phones[0].phone_number) : "Sans numéro"}</span></div><span className="contact-email">{contact.email}</span><div className="contact-actions"><button className="icon-button" disabled={props.busy || !contact.contact_phones.length} aria-label={`Écrire à ${contact.display_name}`} title="Ouvrir la conversation" onClick={() => props.onMessage(contact)}><ChatCircle /></button><button className="icon-button" disabled={props.busy || !contact.contact_phones.length} aria-label={`Appeler ${contact.display_name}`} title="Appeler" onClick={() => props.onCall(contact)}><Phone /></button><button className="icon-button" disabled={props.busy} aria-label={`Modifier ${contact.display_name}`} title="Modifier" onClick={() => props.onEdit(contact)}><PencilSimple /></button><button className="icon-button" disabled={props.busy} aria-label={`Archiver ${contact.display_name}`} title="Archiver" onClick={() => props.onArchive(contact)}><Archive /></button></div></article>)}
      {!props.contacts.length && <EmptyState icon={<Users size={28} />} title={props.dataState === "loading" ? "Chargement des contacts…" : props.dataState === "error" ? "Contacts indisponibles" : props.search ? "Aucun contact trouvé" : "Votre répertoire commence ici"}><p>{props.search ? "Essayez un autre nom." : "Ajoutez un contact pour retrouver facilement ses appels et ses messages."}</p></EmptyState>}
    </div>
  </section>;
}
