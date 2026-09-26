import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "@onoff/api-client";
import type { NumberOffer, NumberOrder } from "@onoff/contracts";

type Attempt = { quoteId: string; key: string };
const countries = [{ code: "FR", name: "France (+33)" }, { code: "BE", name: "Belgique (+32)" }, { code: "GB", name: "Royaume-Uni (+44)" }, { code: "US", name: "États-Unis (+1)" }];
const priceLabel = (offer: NumberOffer) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: offer.currency, maximumFractionDigits: 4 }).format(offer.monthlyPrice);

export function NumberPurchase(props: {
  organizationId: string;
  userId: string;
  email: string;
  api<T>(path: string, init?: RequestInit): Promise<T>;
  onClose(): void;
  onPurchased(lineId: string): Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const submitting = useRef(false);
  const storageKey = `onoff:number-purchase:${props.userId}:${props.organizationId}`;
  const base = `/v1/organizations/${props.organizationId}`;
  const [country, setCountry] = useState("FR");
  const [offers, setOffers] = useState<NumberOffer[] | null>(null);
  const [selected, setSelected] = useState<NumberOffer | null>(null);
  const [order, setOrder] = useState<NumberOrder | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Attempt | null;
      return value && typeof value.key === "string" && typeof value.quoteId === "string" ? value : null;
    } catch { return null; }
  });
  const [checking, setChecking] = useState(true);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);

  function forgetAttempt() {
    try { localStorage.removeItem(storageKey); } catch { /* Server orders remain authoritative. */ }
    setAttempt(null);
  }

  function acceptOrder(value: NumberOrder) {
    setOrder(value);
    setSelected(null);
    if (value.status !== "pending") forgetAttempt();
  }

  async function checkOrders(requestKey = attempt?.key) {
    setChecking(true);
    setError("");
    try {
      const { items } = await props.api<{ items: NumberOrder[] }>(`${base}/number-orders`);
      if (!mounted.current) return;
      const current = items.find((item) => item.status === "pending")
        ?? items.find((item) => item.id === order?.id || item.requestKey === requestKey);
      if (current) acceptOrder(current);
      setVerified(true);
    } catch (cause) {
      if (!mounted.current) return;
      setVerified(false);
      setError(cause instanceof Error ? cause.message : "Impossible de vérifier les commandes.");
    } finally { if (mounted.current) setChecking(false); }
  }

  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    void checkOrders();
    return () => { mounted.current = false; };
  // The parent mounts a separate dialog for each organization and user.
  }, []);

  useEffect(() => {
    if (order?.status !== "pending" || checking) return;
    const timer = window.setTimeout(() => void checkOrders(), 5_000);
    return () => window.clearTimeout(timer);
  }, [order, checking]);

  useEffect(() => {
    if (!selected) { setExpired(false); return; }
    const remaining = Date.parse(selected.expiresAt) - Date.now();
    setExpired(remaining <= 0);
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [selected]);

  async function search() {
    if (!verified || attempt || order?.status === "pending") return;
    setBusy(true);
    setError("");
    setOffers(null);
    setSelected(null);
    setOrder(null);
    try {
      const response = await props.api<{ items: NumberOffer[] }>(`${base}/number-offers?country=${country}`);
      if (mounted.current) setOffers(response.items);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Recherche indisponible."); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function purchase() {
    if (submitting.current || (!attempt && (!selected || expired))) return;
    submitting.current = true;
    const next = attempt ?? { quoteId: selected!.quoteId, key: crypto.randomUUID() };
    // Save the exact retry before any paid request. A server-side pending order also
    // blocks another purchase if storage is unavailable or another tab is used.
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Server guard still applies. */ }
    setAttempt(next);
    setBusy(true);
    setError("");
    try {
      const result = await props.api<NumberOrder>(`${base}/number-orders`, {
        method: "POST", headers: { "idempotency-key": next.key }, body: JSON.stringify({ quoteId: next.quoteId }),
      });
      if (mounted.current) acceptOrder(result);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : "La commande ne peut pas être confirmée.");
      // These errors are returned before submitting anything to Twilio.
      if (cause instanceof ApiClientError && ["quote_expired", "price_changed", "number_unavailable", "number_compliance_required", "number_setup_required", "operations_paused", "invalid_purchase"].includes(cause.code)) {
        forgetAttempt(); setSelected(null); setOffers(null);
      } else {
        // An ambiguous response may hide a successful purchase or another tab's order.
        await checkOrders(next.key);
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function startCalling() {
    if (!order?.lineId) return;
    setBusy(true);
    try { await props.onPurchased(order.lineId); }
    catch { setError("Le numéro a été acheté. Actualisez votre espace pour afficher la nouvelle ligne."); }
    finally { if (mounted.current) setBusy(false); }
  }

  const recovering = Boolean(attempt) || order?.status === "pending";
  return <dialog ref={dialog} className="number-dialog" aria-labelledby="number-dialog-title" onCancel={(event) => { event.preventDefault(); if (!busy) props.onClose(); }}>
    <div className="number-dialog-heading"><div><span className="eyebrow">VOTRE NOUVELLE LIGNE</span><h2 id="number-dialog-title">Ajouter un numéro</h2></div><button className="number-close" aria-label="Fermer" disabled={busy} onClick={props.onClose}>×</button></div>
    <p className="number-intro">Un numéro professionnel attribué automatiquement à <strong>{props.email}</strong>.</p>
    {error && <div className="number-feedback number-error" role="alert">{error}</div>}
    {order?.status === "completed" ? <div className="number-result" role="status"><span className="number-success" aria-hidden="true">✓</span><h3>Votre numéro est prêt</h3><p className="number-result-phone">{order.phoneNumber}</p><p>La ligne a été ajoutée à votre compte.</p><button className="button button-primary" disabled={busy} onClick={() => void startCalling()}>{busy ? "Ouverture…" : "Passer un appel"}</button></div>
      : order?.status === "failed" ? <div className="number-result" role="status"><h3>Commande refusée</h3><p>{order.message}</p><button className="button button-primary" disabled={busy} onClick={() => { setOrder(null); setOffers(null); }}>Choisir un autre numéro</button></div>
      : recovering ? <div className="number-result" role="status"><h3>Confirmation de la commande</h3>{order && <p className="number-result-phone">{order.phoneNumber}</p>}<p>{order?.message ?? "La réponse n’a pas encore été confirmée. Vérifiez cette commande avant de continuer."}</p><p>Vous pouvez fermer cette fenêtre et revenir vérifier plus tard.</p><button className="button button-primary" disabled={busy || checking} onClick={() => void (order ? checkOrders() : purchase())}>{busy || checking ? "Vérification…" : "Vérifier la commande"}</button></div>
      : !verified ? <div className="number-result" role="status"><p>{checking ? "Vérification des commandes en cours…" : "La vérification est nécessaire avant de commander."}</p>{!checking && <button className="button" onClick={() => void checkOrders()}>Réessayer</button>}</div>
      : selected ? <div className="number-confirmation"><button className="number-back" disabled={busy} onClick={() => setSelected(null)}>← Changer de numéro</button><h3>Confirmer votre numéro</h3><p className="number-result-phone">{selected.phoneNumber}</p><div className="number-price"><strong>{priceLabel(selected)}</strong><span> / mois HT · {selected.currency}</span></div><p>Abonnement facturé sur le compte Twilio de votre organisation dès la commande, puis chaque mois. Appels, messages et taxes en supplément.</p>{expired && <p className="number-feedback" role="status">Cette sélection a expiré. Relancez la recherche.</p>}<button className="button button-primary button-wide" disabled={busy || expired} onClick={() => void purchase()}>{busy ? "Commande en cours…" : `Commander · ${priceLabel(selected)} / mois`}</button>{expired && <button className="number-back" onClick={() => void search()}>Actualiser les numéros</button>}</div>
      : <><form className="number-search" onSubmit={(event) => { event.preventDefault(); void search(); }}><label>Pays du numéro<select value={country} disabled={busy} onChange={(event) => { setCountry(event.target.value); setOffers(null); setError(""); }}>{countries.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label><button className="button button-primary" disabled={busy}>{busy ? "Recherche…" : "Voir les numéros"}</button></form><p className="number-note">Numéros locaux compatibles avec les appels. Le prix est confirmé avant l’achat.</p>{offers?.length === 0 && <div className="number-feedback" role="status">Aucun numéro disponible dans ce pays pour le moment. Réessayez plus tard ou choisissez un autre pays.</div>}{offers && offers.length > 0 && <ul className="number-offers" aria-label="Numéros disponibles">{offers.map((offer) => <li key={offer.quoteId}><div><strong>{offer.phoneNumber}</strong><small>Appels{offer.smsEnabled ? " · SMS compatibles" : ""}</small></div><div className="number-offer-price"><strong>{priceLabel(offer)}</strong><small>/ mois HT · {offer.currency}</small></div><button className="button" onClick={() => setSelected(offer)}>Choisir</button></li>)}</ul>}</>}
  </dialog>;
}
