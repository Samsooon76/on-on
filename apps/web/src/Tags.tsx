import { useEffect, useMemo, useState } from "react";
import { Tag as TagIcon, Plus, Sparkle, PencilSimple, Trash, X } from "@phosphor-icons/react";
import { createTagClient, tagStatus, type TagApi } from "@onoff/api-client";
import { tagInputSchema, type Tag, type TagCatalog, type TagInput, type TagKind, type TagSubject } from "@onoff/contracts";
import "./tags.css";
const blank: TagInput = { name: "", kind: "call", color: "#246653", aiEnabled: false, prompt: "" };
const message = (e: unknown) => e instanceof Error ? e.message : "La demande a échoué.";

export function TagManager({ api, organizationId }: { api: TagApi; organizationId: string }) {
  const client = useMemo(() => createTagClient(api), [api]);
  const [catalog, setCatalog] = useState<TagCatalog | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<TagInput | null>(null), [editing, setEditing] = useState<Tag | null>(null);
  const [remove, setRemove] = useState<Tag | null>(null), [threshold, setThreshold] = useState(85);
  useEffect(() => { if (new URLSearchParams(window.location.search).get("settings") === "tags") document.getElementById("call-tags")?.scrollIntoView(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void client.catalog(organizationId, controller.signal).then(data => { setCatalog(data); setThreshold(Math.round(data.settings.confidenceThreshold * 100)); setError(""); }).catch(e => { if (!controller.signal.aborted) setError(message(e)); });
    return () => controller.abort();
  }, [client, organizationId, revision]);
  async function run(action: () => Promise<unknown>) { setBusy(true); setError(""); try { await action(); setRevision(v => v + 1); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  const refresh = () => setRevision(v => v + 1);
  return <section className="settings-section tag-manager" id="call-tags">
    <div className="settings-section-heading"><h3><TagIcon size={18} /> AI call tag</h3>{catalog?.canManage && <button className="text-button" disabled={busy} onClick={() => { setEditing(null); setDraft({ ...blank }); }}><Plus size={15} />Créer un tag</button>}</div>
    <p className="settings-description">Classez vos appels automatiquement : Jev reçoit la transcription et vos tags avec leurs prompts.</p>
    {error && <p className="form-error" role="alert">{error} <button className="text-button" onClick={refresh}>Actualiser</button></p>}
    {!catalog && !error && <p role="status">Chargement des tags…</p>}
    {catalog && <>
      {!catalog.providerAvailable && <p className="tag-hint">Jev n’est pas connecté. Les tags manuels et la préparation des prompts restent disponibles.</p>}
      <label className="tag-switch"><span><b>Activer AI call tag</b><small>Analyse automatique à la fin de chaque transcription.</small></span><input type="checkbox" role="switch" checked={catalog.settings.callsEnabled} disabled={busy || !catalog.canManage || (!catalog.providerAvailable && !catalog.settings.callsEnabled)} onChange={e => void run(() => client.settings(organizationId, { callsEnabled: e.target.checked, confidenceThreshold: catalog.settings.confidenceThreshold }))} /></label>
      <p className="tag-hint">L’activation autorise l’envoi des transcriptions et des prompts de vos tags à TypeSafe AI. Les tags déjà attribués sont conservés à la désactivation.</p>
      <div className="tag-threshold"><label htmlFor="tag-threshold">Confiance minimale <strong>{threshold} %</strong></label><input id="tag-threshold" type="range" min="50" max="99" value={threshold} disabled={!catalog.canManage || busy} onChange={e => setThreshold(Number(e.target.value))} /><button className="text-button" disabled={busy || !catalog.canManage || threshold === Math.round(catalog.settings.confidenceThreshold * 100)} onClick={() => void run(() => client.settings(organizationId, { callsEnabled: catalog.settings.callsEnabled, confidenceThreshold: threshold / 100 }))}>Enregistrer le seuil</button></div>
      {!catalog.items.length && <p className="tag-empty">Aucun tag. Commencez par « À rappeler » ou « Demande de devis ».</p>}
      <div className="tag-catalog">{catalog.items.map(tag => <div className="tag-row" key={tag.id}><span className="tag-color" style={{ background: tag.color }} /><div className="tag-copy"><b>{tag.name}</b><small>{tag.aiEnabled ? "IA activée" : "Manuel"}</small>{tag.prompt && <p>{tag.prompt}</p>}</div>{catalog.canManage && <><button className="icon-button" disabled={busy} aria-label={`Modifier ${tag.name}`} onClick={() => { setEditing(tag); setDraft({ name: tag.name, color: tag.color, kind: tag.kind, aiEnabled: tag.aiEnabled, prompt: tag.prompt }); }}><PencilSimple size={17} /></button><button className="icon-button" disabled={busy} aria-label={`Supprimer ${tag.name}`} onClick={() => setRemove(tag)}><Trash size={17} /></button></>}</div>)}</div>
      {!catalog.canManage && <p className="tag-hint">Un administrateur peut modifier les tags et les réglages IA.</p>}
    </>}
    {remove && <div className="tag-confirm" role="alert"><p>Supprimer « {remove.name} » et ses attributions ?</p><button className="button button-secondary" disabled={busy} onClick={() => setRemove(null)}>Annuler</button><button className="button button-primary" disabled={busy} onClick={() => void run(async () => { await client.remove(remove.id); setRemove(null); })}>Supprimer</button></div>}
    {draft && <form className="tag-editor" onSubmit={e => { e.preventDefault(); const result = tagInputSchema.safeParse(draft); if (!result.success) { setError(result.error.issues[0]?.message ?? "Vérifiez le tag."); return; } void run(async () => { await client.save(organizationId, result.data, editing?.id); setDraft(null); }); }}>
      <h4>{editing ? "Modifier le tag" : "Nouveau tag"}</h4>
      <div className="tag-editor-fields"><label className="field-label">Nom<input required maxLength={60} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="Demande de devis" /></label><label className="field-label">Couleur<input type="color" value={draft.color} onChange={e => setDraft({ ...draft, color: e.target.value })} /></label></div>
      <label className="tag-switch"><span><b>Attribution par IA</b><small>Ce tag et son prompt seront envoyés à Jev quand AI call tag est actif.</small></span><input type="checkbox" role="switch" checked={draft.aiEnabled} onChange={e => setDraft({ ...draft, aiEnabled: e.target.checked })} /></label>
      <label className="field-label">Consigne pour ce tag<textarea rows={3} maxLength={2000} required={draft.aiEnabled} minLength={draft.aiEnabled ? 10 : undefined} value={draft.prompt} onChange={e => setDraft({ ...draft, prompt: e.target.value })} placeholder="Le client demande un prix ou un devis pour un projet précis. Exclure les simples demandes d’information." /></label>
      <div className="modal-actions"><button className="button button-secondary" type="button" disabled={busy} onClick={() => setDraft(null)}>Annuler</button><button className="button button-primary" disabled={busy}>{busy ? "Enregistrement…" : "Enregistrer"}</button></div>
    </form>}
  </section>;
}

export function SubjectTags({ api, kind, id }: { api: TagApi; kind: TagKind; id: string }) {
  const client = useMemo(() => createTagClient(api), [api]);
  const [data, setData] = useState<TagSubject | null>(null), [catalog, setCatalog] = useState<TagCatalog | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
    useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const next = await client.subject(kind, id, controller.signal);
        if (controller.signal.aborted) return;
        setData(next);
        const list = await client.catalog(next.organizationId, controller.signal);
        if (controller.signal.aborted) return;
        setCatalog(list); setError("");
        timer = setTimeout(() => void load(), ["pending", "processing"].includes(next.status) ? 2000 : 15000);
      } catch (e) { if (!controller.signal.aborted) { setData(null); setCatalog(null); setError(message(e)); } }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [client, kind, id, revision]);
  async function run(action: () => Promise<TagSubject>) { setBusy(true); setError(""); try { const next = await action(); setData(next); setRevision(v => v + 1); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  const active = Boolean(catalog?.providerAvailable && catalog.settings.callsEnabled);
  return <section className="subject-tags" aria-label="Tags de l’appel">
    <div className="subject-tags-heading"><h4><TagIcon size={16} />AI call tag</h4><button className="text-button" disabled={busy || !active || !data || ["pending", "processing"].includes(data.status)} onClick={() => void run(() => client.classify(kind, id))}><Sparkle size={15} />Analyser</button></div>
    {error && <p className="form-error" role="alert">{error} <button onClick={() => setRevision(v => v + 1)}>Réessayer</button></p>}
    {data && <><div className="tag-chips">{data.assignments.map(({ tag, source, confidence }) => <span className="tag-chip" key={tag.id}><i style={{ background: tag.color }} />{tag.name}{source === "ai" && <small title={`Confiance : ${Math.round((confidence ?? 0) * 100)} %`}>IA</small>}<button disabled={busy} aria-label={`Retirer ${tag.name}`} onClick={() => void run(() => client.assign(kind, id, tag.id, false))}><X size={12} /></button></span>)}{!data.assignments.length && <span className="tag-hint">Aucun tag attribué</span>}</div>
      <select aria-label="Ajouter un tag" value="" disabled={busy || !catalog} onChange={e => { if (e.target.value) void run(() => client.assign(kind, id, e.target.value, true)); }}><option value="">Ajouter un tag…</option>{catalog?.items.filter(t => t.kind === kind && !data.assignments.some(a => a.tag.id === t.id)).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
      <p className="tag-hint" role="status">{data.message ?? (active ? tagStatus[data.status] : "IA désactivée. Les tags manuels restent disponibles.")}</p>
    </>}
  </section>;
}
