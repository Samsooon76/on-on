import { useEffect, useRef, useState } from "react";
import { Handshake, Ticket } from "@phosphor-icons/react";
import type { CallFollowup, CallFollowupPage } from "@onoff/contracts";
import type { CallActionApi } from "./CallCreateActions";
import { EmptyState } from "./ui";
import { formatPhone } from "./conversation-model";
import "./call-followups.css";

export function CallFollowups({ organizationId, api, onCall }: { organizationId: string; api: CallActionApi; onCall(callId: string): void }) {
  const [kind, setKind] = useState<"" | "ticket" | "deal">("");
  const [items, setItems] = useState<CallFollowup[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  const [updating, setUpdating] = useState("");
  const apiRef = useRef(api); apiRef.current = api;
  const scope = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); scope.current += 1;
    setItems([]); setCursor(null); setLoading(true); setError("");
    void apiRef.current<CallFollowupPage>(`/v1/organizations/${organizationId}/call-followups${kind ? `?kind=${kind}` : ""}`, { signal: controller.signal })
      .then(page => { if (!controller.signal.aborted) { setItems(page.items); setCursor(page.nextCursor); } })
      .catch(caught => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Chargement impossible."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); scope.current += 1; };
  }, [organizationId, kind, revision]);
  async function more() {
    if (!cursor || loading) return;
    const requestScope = scope.current; setLoading(true); setError("");
    try {
      const page = await api<CallFollowupPage>(`/v1/organizations/${organizationId}/call-followups?cursor=${encodeURIComponent(cursor)}${kind ? `&kind=${kind}` : ""}`);
      if (requestScope === scope.current) { setItems(current => [...current, ...page.items]); setCursor(page.nextCursor); }
    } catch (caught) { if (requestScope === scope.current) setError(caught instanceof Error ? caught.message : "Chargement impossible."); }
    finally { if (requestScope === scope.current) setLoading(false); }
  }
  async function update(item: CallFollowup, status: CallFollowup["status"]) {
    if (updating) return;
    const requestScope = scope.current; setUpdating(item.id); setError("");
    try {
      const saved = await api<CallFollowup>(`/v1/call-followups/${item.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      if (requestScope === scope.current) setItems(current => current.map(row => row.id === saved.id ? saved : row));
    } catch (caught) { if (requestScope === scope.current) setError(caught instanceof Error ? caught.message : "Modification impossible."); }
    finally { setUpdating(""); }
  }
  return <section className="followups-page" aria-label="Tickets et deals">
    <header><div><h2>Le suivi de vos appels</h2><p>Les tickets et opportunités créés pendant vos échanges.</p></div><label className="field-label">Afficher<select aria-label="Type de suivi" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="">Tickets et deals</option><option value="ticket">Tickets</option><option value="deal">Deals</option></select></label></header>
    {error && <p className="form-error" role="alert">{error} <button className="text-button" onClick={() => setRevision(value => value + 1)}>Actualiser</button></p>}
    {loading && <p role="status">Chargement des suivis…</p>}
    {!loading && !error && !items.length && <EmptyState icon={<Ticket size={28} />} title="Aucun suivi pour le moment"><p>Pendant ou après un appel, utilisez le bouton + du composeur pour créer un ticket ou un deal.</p></EmptyState>}
    <div className="followups-list">{items.map(item => <article key={item.id}>
      <span className="followup-icon">{item.kind === "ticket" ? <Ticket size={22} /> : <Handshake size={22} />}</span>
      <div className="followup-content"><small>{item.kind === "ticket" ? "Ticket" : "Deal"} · {new Date(item.created_at).toLocaleDateString("fr-FR")}{item.kind === "ticket" && item.priority !== "normal" ? ` · Priorité ${item.priority === "urgent" ? "urgente" : "haute"}` : ""}</small><h3>{item.title}</h3><p>{formatPhone(item.remote_number)}{item.amount !== null ? ` · ${new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(item.amount)}` : ""}</p>{item.description && <p className="followup-description">{item.description}</p>}<button className="text-button" onClick={() => onCall(item.call_id)}>Voir l’appel</button></div>
      <select aria-label={`Statut de ${item.title}`} value={item.status} disabled={Boolean(updating)} onChange={event => void update(item, event.target.value as CallFollowup["status"])}><option value="open">{item.kind === "ticket" ? "Ouvert" : "En cours"}</option>{item.kind === "ticket" ? <option value="closed">Résolu</option> : <><option value="won">Gagné</option><option value="lost">Perdu</option></>}</select>
    </article>)}</div>
    {cursor && <button className="button button-secondary" disabled={loading} onClick={() => void more()}>Charger la suite</button>}
  </section>;
}
