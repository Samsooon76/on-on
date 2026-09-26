import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowRight, CheckCircle, Copy, Plug, ShieldCheck } from "@phosphor-icons/react";
import { mcpPermissionLabels, type McpGrant, type McpPermission, type McpSmsAction, type McpSmsDraft } from "@onoff/contracts";
import { getSmsSegmentInfo } from "@onoff/api-client";
import { supabase } from "./backend";
import { Modal } from "./ui";
import "./mcp.css";

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
type Organization = { organization_id: string; organizations: { id: string; name: string } | null };
type Assignment = { can_voice: boolean; can_sms: boolean; lines: { id: string; phone_number: string } | null };
type Authorization = { authorization_id: string; client: { id: string; name: string }; scope: string; redirect_uri: string } | { redirect_url: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : "L’intégration est momentanément indisponible.";
const stateText = (draft: McpSmsDraft) => draft.state === "submitted" ? "Envoi préparé · voir le statut" : draft.state === "rejected" ? "Refusé" : Date.parse(draft.expires_at) <= Date.now() ? "Expiré" : draft.state === "approved" ? "Autorisé, en attente d’envoi" : "À valider";

export function McpIntegrations({ api, initialDraftId = "" }: { api: Api; initialDraftId?: string }) {
  const apiRef = useRef(api); apiRef.current = api;
  const [config, setConfig] = useState<{ enabled: boolean; endpoint: string } | null>(null);
  const [grants, setGrants] = useState<McpGrant[]>([]);
  const [drafts, setDrafts] = useState<McpSmsDraft[]>([]);
  const [partial, setPartial] = useState(false);
  const [draftId, setDraftId] = useState(initialDraftId);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try {
      const info = await apiRef.current<{ enabled: boolean; endpoint: string }>("/v1/mcp/config", signal ? { signal } : {});
      if (signal?.aborted) return;
      setConfig(info);
      if (info.enabled) {
        const [connections, messages] = await Promise.all([
          apiRef.current<{ items: McpGrant[] }>("/v1/mcp/grants", signal ? { signal } : {}),
          apiRef.current<{ items: McpSmsDraft[]; partial: boolean }>("/v1/mcp/sms-drafts", signal ? { signal } : {}),
        ]);
        if (signal?.aborted) return;
        setGrants(connections.items); setDrafts(messages.items); setPartial(messages.partial);
      }
    } catch (caught) { if (!signal?.aborted) setError(errorText(caught)); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  async function revoke(grant: McpGrant) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await apiRef.current<{ oauthRevoked: boolean }>(`/v1/mcp/grants/${grant.id}/revoke`, { method: "POST" });
      await load();
      setNotice(result.oauthRevoked ? `L’accès de ${grant.client_name} a été révoqué.` : "L’accès Onoff est révoqué. La fermeture de la session de l’assistant reste à reprendre.");
    } catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  }
  return <section className="settings-section mcp-integrations">
    <div className="settings-section-heading"><h3><Plug size={20}/>Assistants IA</h3><button className="text-button" disabled={loading || busy} onClick={() => void load()}><ArrowClockwise size={16}/>Actualiser</button></div>
    <p className="settings-description">Connectez votre assistant à Onoff. Vous choisissez les données accessibles ; chaque SMS doit être validé ici avant son envoi.</p>
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="mcp-notice" role="status">{notice}</p>}
    {loading && <p role="status">Chargement des intégrations…</p>}
    {config && !config.enabled && <p className="settings-description">Les intégrations IA ne sont pas encore activées sur cet environnement.</p>}
    {config?.enabled && <>
      <div className="mcp-endpoint"><label className="field-label">Adresse du connecteur MCP<input readOnly value={config.endpoint} aria-label="Adresse du connecteur MCP"/></label><button className="button button-secondary" onClick={() => void navigator.clipboard.writeText(config.endpoint).then(() => setNotice("Adresse copiée.")).catch(() => setError("La copie est indisponible. Sélectionnez l’adresse pour la copier."))}><Copy size={17}/>Copier</button></div>
      <p className="settings-description">Ajoutez cette adresse dans les connexions MCP de votre assistant, puis connectez-vous à Onoff pour choisir l’organisation, les lignes et les permissions. Les données consultées seront transmises à cet assistant.</p>
      <h4>Connexions autorisées</h4>
      {!loading && !grants.length && <p className="settings-description">Aucun assistant connecté.</p>}
      {grants.map(grant => <article className="mcp-connection" key={grant.id}><div><b>{grant.client_name}</b><p>{grant.line_ids.length} ligne(s) sélectionnée(s) · {grant.last_used_at ? `Dernière utilisation : ${new Date(grant.last_used_at).toLocaleString("fr-FR")}` : "Pas encore utilisé"}</p><ul>{grant.permissions.map(permission => <li key={permission}>{mcpPermissionLabels[permission]}</li>)}</ul></div><button className="text-button danger-text" disabled={busy} onClick={() => void revoke(grant)}>Révoquer</button></article>)}
      <h4>SMS proposés par vos assistants</h4>
      {!loading && !drafts.length && <p className="settings-description">Aucun SMS à examiner.</p>}
      {drafts.map(draft => <button className="mcp-draft-row" key={draft.id} onClick={() => setDraftId(draft.id)}><div><b>{draft.destination}</b><p>{draft.body}</p><span>{stateText(draft)}</span></div><ArrowRight size={18}/></button>)}
      {partial && <p className="settings-description">Les 50 propositions les plus récentes sont affichées. Un lien de validation permet aussi d’ouvrir une proposition plus ancienne.</p>}
    </>}
    {draftId && config?.enabled && <SmsApproval api={api} id={draftId} onChanged={() => void load()} onClose={() => { setDraftId(""); const url = new URL(window.location.href); url.searchParams.delete("mcpSms"); window.history.replaceState(null, "", url); }}/>}
  </section>;
}

export function SmsApproval({ api, id, onClose, onChanged }: { api: Api; id: string; onClose: () => void; onChanged: () => void }) {
  const apiRef = useRef(api); apiRef.current = api;
  const [draft, setDraft] = useState<McpSmsAction | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await apiRef.current<McpSmsAction>(`/v1/mcp/sms-drafts/${encodeURIComponent(id)}`, signal ? { signal } : {});
    if (!signal?.aborted) setDraft(result);
  }, [id]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal).catch(caught => { if (!controller.signal.aborted) setError(errorText(caught)); }); return () => controller.abort(); }, [load]);
  async function decide(approve: boolean) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await apiRef.current(`/v1/mcp/sms-drafts/${encodeURIComponent(id)}/decision`, { method: "POST", body: JSON.stringify({ approve }) });
      if (approve) await apiRef.current(`/v1/mcp/sms-drafts/${encodeURIComponent(id)}/send`, { method: "POST" });
    } catch (caught) { setError(errorText(caught)); }
    finally { await load().catch(caught => setError(errorText(caught))); onChanged(); setBusy(false); }
  }
  const expired = draft && Date.parse(draft.expires_at) <= Date.now();
  const actionable = draft && !expired && (draft.state === "pending" || draft.state === "approved");
  const segments = getSmsSegmentInfo(draft?.body ?? "");
  return <Modal title="Valider un SMS" onClose={() => { if (!busy) onClose(); }}><div className="mcp-approval">
    {error && <p className="form-error" role="alert">{error}</p>}
    {!draft && !error && <p role="status">Chargement du SMS…</p>}
    {draft && <>
      <p>Proposé par <b>{draft.clientName}</b>. Vérifiez le destinataire, la ligne et le texte avant d’autoriser l’envoi.</p>
      <dl><div><dt>Destinataire</dt><dd>{draft.destination}</dd></div><div><dt>Depuis votre ligne</dt><dd>{draft.lineNumber}</dd></div></dl>
      <div className="mcp-message">{draft.body}</div>
      <p className="settings-description">{segments.segments} segment(s) estimé(s) · {segments.encoding} · Validation valable jusqu’au {new Date(draft.expires_at).toLocaleString("fr-FR")}. La facturation habituelle de la ligne s’applique.</p>
      {draft.state === "submitted" ? <p className="mcp-notice" role="status">{draft.messageStatus === "delivered" ? "SMS livré." : draft.messageStatus === "sent" ? "SMS envoyé, livraison non confirmée." : draft.messageStatus === "failed" || draft.messageStatus === "undelivered" ? "Le SMS n’a pas abouti." : draft.submissionConfirmed ? "Le fournisseur a accepté le SMS. Livraison en attente." : "Résultat d’envoi à vérifier. Ne recréez pas ce SMS."}</p> : <p role="status">{stateText(draft)}</p>}
      <div className="mcp-actions">{actionable && <><button className="button button-secondary" disabled={busy} onClick={() => void decide(false)}>Refuser</button><button className="button button-primary" disabled={busy} onClick={() => void decide(true)}><CheckCircle size={18}/>{busy ? "Traitement…" : "Valider et envoyer ce SMS"}</button></>}<button className="text-button" disabled={busy} onClick={() => void load().then(() => setError("")).catch(caught => setError(errorText(caught)))}>Actualiser le statut</button></div>
    </>}
  </div></Modal>;
}

export function McpConsent({ api, authorizationId, organizations }: { api: Api; authorizationId: string; organizations: Organization[] }) {
  const apiRef = useRef(api); apiRef.current = api;
  const [authorization, setAuthorization] = useState<Authorization | null>(null);
  const [organizationId, setOrganizationId] = useState("");
  const [lines, setLines] = useState<Assignment[]>([]); const [lineIds, setLineIds] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<McpPermission[]>(["contacts:read", "messages:read", "calls:read"]);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [linesLoading, setLinesLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void apiRef.current<Authorization>(`/v1/mcp/authorizations/${encodeURIComponent(authorizationId)}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      if ("redirect_url" in result) window.location.assign(result.redirect_url); else setAuthorization(result);
    }).catch(caught => { if (!controller.signal.aborted) setError(errorText(caught)); });
    return () => controller.abort();
  }, [authorizationId]);
  useEffect(() => { if (!organizationId && organizations.length) setOrganizationId(organizations[0]!.organization_id); }, [organizationId, organizations]);
  useEffect(() => {
    setLines([]); setLineIds([]); if (!organizationId) return;
    const controller = new AbortController(); setLinesLoading(true);
    void apiRef.current<{ items: Assignment[] }>(`/v1/organizations/${organizationId}/lines`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setLines(result.items); }).catch(caught => { if (!controller.signal.aborted) setError(errorText(caught)); }).finally(() => { if (!controller.signal.aborted) setLinesLoading(false); });
    return () => controller.abort();
  }, [organizationId]);
  function togglePermission(permission: McpPermission, selected: boolean) {
    setPermissions(current => {
      let next = selected ? [...current, permission] : current.filter(value => value !== permission);
      if (selected && permission === "contacts:write" && !next.includes("contacts:read")) next.push("contacts:read");
      if (!selected && permission === "contacts:read") next = next.filter(value => value !== "contacts:write");
      return next;
    });
  }
  async function decide(approve: boolean) {
    if (!supabase || busy) return; setBusy(true); setError(""); let grantId: string | null = null;
    try {
      if (approve) grantId = (await apiRef.current<{ id: string }>("/v1/mcp/grants", { method: "POST", body: JSON.stringify({ authorizationId, organizationId, lineIds, permissions }) })).id;
      const result = approve ? await supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true }) : await supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
      if (result.error || !result.data) throw new Error("La connexion n’a pas pu être terminée. Relancez-la depuis votre assistant.");
      window.location.assign(result.data.redirect_url);
    } catch (caught) {
      if (grantId) await apiRef.current(`/v1/mcp/grants/${grantId}/revoke`, { method: "POST" }).catch(() => undefined);
      setError(errorText(caught)); setBusy(false);
    }
  }
  const requiresLines = permissions.some(value => value.startsWith("messages:") || value.startsWith("calls:"));
  return <main className="mcp-consent-shell"><section className="mcp-consent"><span className="brand-mark">o</span><h1>Connecter votre assistant</h1><p><b>{authorization && "client" in authorization ? authorization.client.name : "Votre assistant"}</b> demande un accès à votre compte Onoff.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!authorization && !error && <p role="status">Vérification de la demande…</p>}
    {authorization && "client" in authorization && <>
      <label className="field-label">Organisation<select value={organizationId} disabled={busy} onChange={event => setOrganizationId(event.target.value)}><option value="" disabled>Choisir une organisation</option>{organizations.map(org => <option key={org.organization_id} value={org.organization_id}>{org.organizations?.name ?? "Organisation"}</option>)}</select></label>
      <fieldset disabled={busy}><legend>Permissions accordées</legend>{(Object.keys(mcpPermissionLabels) as McpPermission[]).map(permission => <label className="mcp-checkbox" key={permission}><input type="checkbox" checked={permissions.includes(permission)} onChange={event => togglePermission(permission, event.target.checked)}/><span>{mcpPermissionLabels[permission]}</span></label>)}</fieldset>
      <fieldset disabled={busy || linesLoading}><legend>Lignes accessibles</legend>{linesLoading ? <p>Chargement des lignes…</p> : lines.filter(line => line.lines).map(line => <label className="mcp-checkbox" key={line.lines!.id}><input type="checkbox" checked={lineIds.includes(line.lines!.id)} onChange={event => setLineIds(current => event.target.checked ? [...current, line.lines!.id] : current.filter(id => id !== line.lines!.id))}/><span>{line.lines!.phone_number} · {line.can_voice ? "Appels" : ""}{line.can_voice && line.can_sms ? " et " : ""}{line.can_sms ? "SMS" : ""}</span></label>)}{!linesLoading && !lines.length && <p>Aucune ligne attribuée dans cette organisation.</p>}</fieldset>
      <p className="mcp-consent-note"><ShieldCheck size={20}/>Les contacts sont partagés dans toute l’organisation. Les données consultées seront transmises à votre assistant. Vous pourrez révoquer cette connexion dans les réglages ; chaque SMS demandera votre validation dans Onoff.</p>
      {authorization.scope && <p className="settings-description">Informations d’identité demandées : {authorization.scope}</p>}
      <div className="mcp-actions"><button className="button button-secondary" disabled={busy} onClick={() => void decide(false)}>Refuser</button><button className="button button-primary" disabled={busy || linesLoading || !organizationId || !permissions.length || (requiresLines && !lineIds.length)} onClick={() => void decide(true)}>{busy ? "Connexion…" : "Autoriser cette connexion"}<ArrowRight size={18}/></button></div>
    </>}
  </section></main>;
}
