import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle, Handshake, Plus, Ticket, UserPlus, X } from "@phosphor-icons/react";
import { callFollowupInputSchema, normalizePhoneNumber, type CallFollowupInput } from "@onoff/contracts";
import { formatPhone, type Contact } from "./conversation-model";
import "./call-followups.css";

export type CallActionContext = { key: string; number: string; intentId?: string; providerCallSid?: string; callId?: string };
export type CallActionApi = <T>(path: string, init?: RequestInit) => Promise<T>;
type Kind = "ticket" | "deal" | "contact";
const labels = { ticket: "Créer un ticket", deal: "Créer un deal", contact: "Créer un contact" };

export function CallCreateActions({ organizationId, context, api, disabled = false, initialNotes = "", onContactSaved, onEditingChange }: {
  organizationId: string; context: CallActionContext; api: CallActionApi; disabled?: boolean; initialNotes?: string;
  onContactSaved?(): void; onEditingChange?(editing: boolean): void;
}) {
  const [open, setOpen] = useState(false), [kind, setKind] = useState<Kind | null>(null);
  const [title, setTitle] = useState(""), [description, setDescription] = useState(initialNotes);
  const [email, setEmail] = useState(""), [priority, setPriority] = useState<CallFollowupInput["priority"]>("normal"), [amount, setAmount] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]), [contactId, setContactId] = useState("");
  const [lookup, setLookup] = useState<"loading" | "ready" | "error">("loading"), [lookupVersion, setLookupVersion] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [success, setSuccess] = useState("");
  const requestId = useRef(crypto.randomUUID()), submitting = useRef(false), trigger = useRef<HTMLButtonElement>(null);
  const apiRef = useRef(api); apiRef.current = api;
  const editingRef = useRef(onEditingChange); editingRef.current = onEditingChange;
  const panelId = useId();
  const number = normalizePhoneNumber(context.number);
  const linked = Boolean(context.callId || context.intentId || context.providerCallSid);

  useEffect(() => { editingRef.current?.(open); return () => editingRef.current?.(false); }, [open]);
  useEffect(() => {
    const controller = new AbortController();
    setLookup("loading");
    if (!number) { setContacts([]); setContactId(""); setLookup("ready"); return; }
    void apiRef.current<{ items: Contact[] }>(`/v1/organizations/${organizationId}/contacts?q=${encodeURIComponent(number)}&limit=100`, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        const matches = result.items.filter(contact => contact.contact_phones.some(phone => phone.phone_number === number));
        setContacts(matches); setContactId(matches.length === 1 ? matches[0]!.id : ""); setLookup("ready");
      }).catch(() => { if (!controller.signal.aborted) setLookup("error"); });
    return () => controller.abort();
  }, [organizationId, number, lookupVersion]);

  function close() { setOpen(false); setKind(null); setError(""); trigger.current?.focus(); }
  function choose(next: Kind) {
    setKind(next); setTitle(""); setDescription(initialNotes); setEmail(""); setAmount(""); setPriority("normal");
    setError(""); setSuccess(""); requestId.current = crypto.randomUUID();
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!kind || submitting.current || disabled) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      if (kind === "contact") {
        if (!number) throw new Error("Le numéro de cet appel ne permet pas de créer un contact.");
        // Recheck on every attempt, including after an uncertain network response.
        const existing = await api<{ items: Contact[] }>(`/v1/organizations/${organizationId}/contacts?q=${encodeURIComponent(number)}&limit=100`);
        const matches = existing.items.filter(contact => contact.contact_phones.some(phone => phone.phone_number === number));
        if (matches.length) {
          setContacts(matches); setContactId(matches.length === 1 ? matches[0]!.id : "");
          throw new Error(`Ce numéro est déjà enregistré : ${matches.map(contact => contact.display_name).join(", ")}.`);
        }
        const saved = await api<{ id: string }>(`/v1/organizations/${organizationId}/contacts`, { method: "POST", body: JSON.stringify({ displayName: title.trim(), email: email.trim() || null, phones: [{ phoneNumber: number, label: "Mobile" }] }) });
        setContacts([{ id: saved.id, display_name: title.trim(), email: email.trim() || null, version: 1, contact_phones: [{ id: "new", phone_number: number, label: "Mobile" }] }]);
        setContactId(saved.id); setLookup("ready"); onContactSaved?.();
        setSuccess("Contact enregistré dans le carnet partagé.");
      } else {
        const payload = callFollowupInputSchema.safeParse({ id: requestId.current, kind, title, description, priority,
          amount: kind === "deal" && amount.trim() ? Number(amount.replace(",", ".")) : null, contactId: contactId || null,
          ...(context.callId ? { callId: context.callId } : context.providerCallSid ? { providerCallSid: context.providerCallSid } : { intentId: context.intentId }) });
        if (!payload.success) throw new Error(payload.error.issues[0]?.message ?? "Vérifiez le formulaire.");
        await api(`/v1/organizations/${organizationId}/call-followups`, { method: "POST", body: JSON.stringify(payload.data) });
        setSuccess(`${kind === "ticket" ? "Ticket créé" : "Deal créé"} et lié à cet appel. Retrouvez-le dans Tickets & deals.`);
      }
      close();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Enregistrement impossible. Votre saisie est conservée."); }
    finally { submitting.current = false; setBusy(false); }
  }

  return <section className="call-create" aria-label="Créer depuis cet appel">
    <button ref={trigger} className="button button-secondary call-create-trigger" type="button" aria-expanded={open} aria-controls={panelId} aria-label="Créer depuis cet appel" disabled={disabled || busy} onClick={() => open ? close() : setOpen(true)}><Plus size={19} />Créer</button>
    {success && <p className="call-create-success" role="status"><CheckCircle size={17} />{success}</p>}
    {open && <div id={panelId} className="call-create-panel">
      <div className="call-create-heading"><h3>{kind ? labels[kind] : "Créer depuis cet appel"}</h3><button className="icon-button" type="button" aria-label="Fermer la création" disabled={busy} onClick={close}><X size={17} /></button></div>
      <p className="call-create-context">{formatPhone(context.number)}{contactId ? ` · ${contacts.find(contact => contact.id === contactId)?.display_name ?? "Contact associé"}` : ""}</p>
      {!kind ? <div className="call-create-options">
        <button type="button" disabled={!linked} onClick={() => choose("ticket")}><Ticket size={20} /><span><b>Ticket</b><small>Une demande à traiter</small></span></button>
        <button type="button" disabled={!linked} onClick={() => choose("deal")}><Handshake size={20} /><span><b>Deal</b><small>Une opportunité commerciale</small></span></button>
        <button type="button" disabled={!number || lookup !== "ready" || contacts.length > 0} onClick={() => choose("contact")}><UserPlus size={20} /><span><b>Contact</b><small>{contacts.length ? "Ce numéro est déjà enregistré" : "Enregistrer ce numéro"}</small></span></button>
        {!linked && <p className="form-note">Tickets et deals disponibles dès le lancement de l’appel.</p>}
      </div> : <form className="call-create-form" onSubmit={event => void save(event)}>
        <label className="field-label">{kind === "contact" ? "Nom du contact" : "Titre"}<input autoFocus required maxLength={kind === "contact" ? 120 : 160} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} placeholder={kind === "ticket" ? "Ex. Problème de facturation" : kind === "deal" ? "Ex. Offre équipe commerciale" : "Prénom Nom"} /></label>
        {kind === "contact" ? <><label className="field-label">Téléphone<input readOnly value={formatPhone(context.number)} /></label><label className="field-label">Email <span className="optional-label">(facultatif)</span><input type="email" maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></label></> : <>
          <label className="field-label">{kind === "ticket" ? "Description" : "Notes"}<textarea rows={3} maxLength={5000} value={description} disabled={busy} onChange={event => setDescription(event.target.value)} placeholder="Informations utiles, prochaine étape…" /></label>
          {kind === "ticket" ? <label className="field-label">Priorité<select value={priority} disabled={busy} onChange={event => setPriority(event.target.value as typeof priority)}><option value="normal">Normale</option><option value="high">Haute</option><option value="urgent">Urgente</option></select></label> : <label className="field-label">Montant estimé (€) <span className="optional-label">(facultatif)</span><input type="number" min="0" max="999999999" step="0.01" value={amount} disabled={busy} onChange={event => setAmount(event.target.value)} placeholder="0,00" /></label>}
          {contacts.length > 1 && <label className="field-label">Contact associé<select value={contactId} disabled={busy} onChange={event => setContactId(event.target.value)}><option value="">Sans contact</option>{contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.display_name}</option>)}</select></label>}
          <p className="form-note">Lié à cet appel{contactId ? " et au contact associé" : " et à son numéro"}.</p>
        </>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions"><button className="button button-secondary" type="button" disabled={busy} onClick={close}>Annuler</button><button className="button button-primary" disabled={busy || disabled || lookup === "loading" || (kind === "contact" && lookup !== "ready")}>{busy ? "Enregistrement…" : labels[kind]}</button></div>
      </form>}
      {lookup === "loading" && <p className="form-note" role="status">Recherche du contact…</p>}
      {lookup === "error" && <p className="form-error" role="alert">Impossible de vérifier le contact. <button className="text-button" type="button" onClick={() => setLookupVersion(value => value + 1)}>Réessayer</button></p>}
    </div>}
  </section>;
}
