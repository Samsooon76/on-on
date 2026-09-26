import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, CheckCircle, GitBranch, MagnifyingGlass, Phone, Plus, ShieldCheck, Trash, Users } from "@phosphor-icons/react";
import { ApiClientError } from "@onoff/api-client";
import { defaultIvrConfig, ivrConfigSchema, type AdminMember, type AdminLine, type AdminSnapshot, type IvrConfig } from "@onoff/contracts";
import { Avatar, EmptyState, Modal } from "./ui";
import { formatPhone } from "./conversation-model";
import "./admin.css";

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
type Props = { organizationId: string; userId: string; api: Api; onPurchase(): void; onChanged(): Promise<void>; refreshKey: number; purchaseEnabled: boolean };
const roles = { admin: "Administrateur", member: "Membre" };
const statuses = { active: "Actif", suspended: "Suspendu", revoked: "Accès retiré" };
const errorText = (error: unknown) => error instanceof Error ? error.message : "Une erreur est survenue. Réessayez.";
const auditLabels: Record<string, string> = { "member.create": "Création d’un utilisateur", "member.update": "Modification d’un utilisateur", "ivr.update": "Configuration du menu vocal", "line_assignment.upsert": "Modification des droits sur une ligne", "line_assignment.revoke": "Retrait d’accès à une ligne", "number.purchase": "Achat d’un numéro" };

export function Admin({ organizationId, userId, api, onPurchase, onChanged, refreshKey, purchaseEnabled }: Props) {
  const [tab, setTab] = useState<"members" | "lines" | "roles" | "audit">("members");
  const [data, setData] = useState<AdminSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<AdminMember | "new" | null>(null);
  const [lineEditor, setLineEditor] = useState<AdminLine | null>(null);
  const [ivrEditor, setIvrEditor] = useState<AdminLine | null>(null);
  const request = useRef(api); request.current = api;
  const generation = useRef(0);
  const base = `/v1/organizations/${organizationId}/admin`;

  async function reload() {
    const version = ++generation.current;
    setLoading(true); setError("");
    try {
      const result = await request.current<AdminSnapshot>(base);
      if (version === generation.current) setData(result);
    } catch (caught) {
      if (version === generation.current) {
        setError(errorText(caught));
        setData(null);
        if (caught instanceof ApiClientError && caught.status === 403) { setEditor(null); setLineEditor(null); setIvrEditor(null); }
      }
    } finally { if (version === generation.current) setLoading(false); }
  }
  useEffect(() => { void reload(); return () => { generation.current += 1; }; }, [organizationId, refreshKey]);
  async function saved(message: string) {
    setNotice(message); setEditor(null); setLineEditor(null); setIvrEditor(null);
    await reload();
    try { await onChanged(); } catch { setNotice(`${message} Actualisez l’espace pour recharger vos accès.`); }
  }
  const activeMembers = data?.members.filter((member) => member.status === "active") ?? [];
  const shownMembers = data?.members.filter((member) => `${member.display_name} ${member.email}`.toLocaleLowerCase("fr").includes(search.toLocaleLowerCase("fr"))) ?? [];

  return <section className="admin-page">
    <div className="admin-intro"><div><span className="admin-eyebrow"><ShieldCheck size={15} />Administration de l’espace</span><h2>Une équipe, les bons accès.</h2><p>Gérez les utilisateurs, les numéros et l’accueil de vos appels.</p></div><button className="button button-secondary" disabled={loading} onClick={() => void reload()}><ArrowClockwise size={16} />Actualiser</button></div>
    <nav className="admin-tabs" aria-label="Rubriques d’administration">{([
      ["members", "Utilisateurs", Users], ["lines", "Numéros & IVR", Phone], ["roles", "Rôles & permissions", ShieldCheck], ["audit", "Historique", ArrowClockwise],
    ] as const).map(([key, label, Icon]) => <button key={key} aria-current={tab === key ? "page" : undefined} className={tab === key ? "active" : ""} onClick={() => setTab(key)}><Icon size={17} />{label}{key === "members" && data && <span>{data.members.length}</span>}</button>)}</nav>
    {notice && <p className="admin-notice" role="status"><CheckCircle size={17} />{notice}</p>}
    {error && <div className="admin-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => void reload()}>Réessayer</button></div>}
    {loading && !data && <p className="admin-loading" role="status">Chargement de l’administration…</p>}
    {data && tab === "members" && <>
      <div className="admin-toolbar"><label className="search-field"><MagnifyingGlass size={17} /><input aria-label="Rechercher un utilisateur" placeholder="Rechercher un nom, un email…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><button className="button button-primary" onClick={() => setEditor("new")}><Plus size={17} />Créer un utilisateur</button></div>
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Utilisateur</th><th>Rôle</th><th>Accès</th><th>Lignes</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{shownMembers.map((member) => <tr key={member.user_id}><td><div className="admin-person"><Avatar name={member.display_name} /><span><b>{member.display_name}{member.user_id === userId && <small>Vous</small>}</b><span>{member.email}</span></span></div></td><td>{roles[member.role]}</td><td><span className={`admin-status ${member.status}`}>{statuses[member.status]}</span></td><td>{data.assignments.filter((assignment) => assignment.user_id === member.user_id && assignment.status === "active").length}</td><td><button className="text-button" aria-label={`Gérer ${member.display_name}`} onClick={() => setEditor(member)}>Gérer</button></td></tr>)}</tbody></table></div>
      {!shownMembers.length && <EmptyState icon={<Users size={26} />} title="Aucun utilisateur trouvé"><p>Essayez un autre nom ou une autre adresse email.</p></EmptyState>}
      <p className="admin-footnote">{activeMembers.length} utilisateur{activeMembers.length > 1 ? "s" : ""} actif{activeMembers.length > 1 ? "s" : ""} · Les droits Appels et SMS se règlent pour chaque numéro.</p>
    </>}
    {data && tab === "lines" && <>
      <div className="admin-toolbar"><div><h3>Les numéros de votre équipe</h3><p>Attribuez les accès, puis configurez le menu d’accueil.</p></div><button className="button button-primary" disabled={!purchaseEnabled} onClick={onPurchase}><Plus size={17} />Ajouter un numéro</button></div>
      <div className="admin-lines">{data.lines.map((line) => {
        const assignments = data.assignments.filter((a) => a.line_id === line.id && a.status === "active");
        return <article className="admin-line" key={line.id}><div className="admin-line-heading"><span className="admin-line-icon"><Phone size={22} /></span><div><h3>{formatPhone(line.phone_number)}</h3><p>{line.voice_enabled ? "Appels" : "Sans appels"} · {line.sms_enabled ? "SMS" : "Sans SMS"}</p></div><span className={`admin-status ${line.status}`}>{line.status === "active" ? "Actif" : line.status === "suspended" ? "Suspendu" : "Résilié"}</span></div><div className="admin-line-detail"><span>Utilisateurs autorisés</span><b>{assignments.length}</b></div><div className="admin-line-detail"><span><GitBranch size={16} />Menu vocal</span><b>{line.ivr_config.enabled ? `${line.ivr_config.options.length} touches` : "Appel direct"}</b></div><div className="admin-line-actions"><button className="button button-secondary" onClick={() => setLineEditor(line)}>Gérer les accès</button><button className="text-button" disabled={!line.voice_enabled || line.status !== "active"} onClick={() => setIvrEditor(line)}>Configurer l’IVR</button></div></article>;
      })}</div>
      {!data.lines.length && <EmptyState icon={<Phone size={26} />} title="Votre premier numéro"><p>Ajoutez un numéro, puis attribuez-le aux membres de votre équipe.</p><button className="button button-primary" disabled={!purchaseEnabled} onClick={onPurchase}>Ajouter un numéro</button></EmptyState>}
    </>}
    {tab === "roles" && <div className="admin-permissions"><h3>Des permissions explicites</h3><p>Le rôle s’applique à cet espace. Les droits d’utilisation se règlent séparément sur chaque ligne et s’appliquent au web comme au mobile.</p><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Permission</th><th>Administrateur</th><th>Membre</th></tr></thead><tbody>{[
      ["Créer, suspendre et gérer les utilisateurs", "Autorisé", "Non autorisé"], ["Attribuer les rôles et les lignes", "Autorisé", "Non autorisé"], ["Acheter des numéros et configurer les IVR", "Autorisé", "Non autorisé"], ["Consulter l’historique d’administration", "Autorisé", "Non autorisé"], ["Appeler et consulter les appels", "Selon le droit Appels de la ligne", "Selon le droit Appels de la ligne"], ["Envoyer et consulter les SMS", "Selon le droit SMS de la ligne", "Selon le droit SMS de la ligne"], ["Gérer les contacts de l’espace", "Autorisé", "Autorisé"],
    ].map(([permission, admin, member]) => <tr key={permission}><td>{permission}</td><td>{admin}</td><td>{member}</td></tr>)}</tbody></table></div><p className="admin-footnote">Un utilisateur suspendu perd l’accès à cet espace. Retirer son accès révoque également ses affectations de lignes. Le dernier administrateur actif est protégé.</p></div>}
    {data && tab === "audit" && <div className="admin-audit"><h3>Dernières modifications</h3><p>Les 50 dernières actions d’administration de cet espace.</p>{data.audit.map((event) => <div className="admin-audit-row" key={event.id}><span className="admin-audit-icon"><ShieldCheck size={18} /></span><div><b>{auditLabels[event.action] ?? event.action}</b><p>{data.members.find((member) => member.user_id === event.actor_user_id)?.display_name ?? "Système"}{event.target_type === "member" ? ` · ${data.members.find((member) => member.user_id === event.target_id)?.display_name ?? "Utilisateur"}` : event.target_type === "line" ? ` · ${data.lines.find((line) => line.id === event.target_id)?.phone_number ?? "Ligne"}` : ""}</p></div><time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</time></div>)}{!data.audit.length && <EmptyState icon={<ArrowClockwise size={26} />} title="Aucune modification enregistrée"><p>Les prochaines actions apparaîtront ici.</p></EmptyState>}</div>}
    {editor && data && <MemberEditor member={editor} lastAdmin={editor !== "new" && editor.role === "admin" && editor.status === "active" && activeMembers.filter((member) => member.role === "admin").length === 1} api={api} base={base} onClose={() => setEditor(null)} onSaved={() => saved(editor === "new" ? "Utilisateur créé. Vous pouvez maintenant lui attribuer une ligne." : "Les accès de l’utilisateur ont été mis à jour.")} />}
    {lineEditor && data && <AssignmentEditor line={lineEditor} data={data} api={api} base={`/v1/organizations/${organizationId}`} onClose={() => setLineEditor(null)} onSaved={() => saved("Les droits sur cette ligne ont été mis à jour.")} />}
    {ivrEditor && data && <IvrEditor line={ivrEditor} data={data} api={api} base={base} onClose={() => setIvrEditor(null)} onSaved={() => saved("La configuration du menu vocal a été enregistrée.")} />}
  </section>;
}

function MemberEditor({ member, lastAdmin, api, base, onClose, onSaved }: { member: AdminMember | "new"; lastAdmin: boolean; api: Api; base: string; onClose(): void; onSaved(): Promise<void> }) {
  const isNew = member === "new";
  const [name, setName] = useState(isNew ? "" : member.display_name);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AdminMember["role"]>(isNew ? "member" : member.role);
  const [status, setStatus] = useState<AdminMember["status"]>(isNew ? "active" : member.status);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (submitting.current) return; submitting.current = true; setBusy(true); setError("");
    try {
      await api(`${base}/members${isNew ? "" : `/${member.user_id}`}`, { method: isNew ? "POST" : "PATCH", body: JSON.stringify(isNew ? { displayName: name.trim(), email: email.trim(), password, role } : { displayName: name.trim(), role, status, version: member.updated_at }) });
      setPassword(""); await onSaved();
    } catch (caught) { setError(errorText(caught)); } finally { submitting.current = false; setBusy(false); }
  }
  return <Modal title={isNew ? "Créer un utilisateur" : "Gérer l’utilisateur"} onClose={onClose} busy={busy}><form className="contact-form" onSubmit={submit}><fieldset disabled={busy} className="admin-fieldset"><label className="field-label">Nom complet<input autoFocus required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>{isNew ? <><label className="field-label">Adresse email<input type="email" autoComplete="off" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></label><label className="field-label">Mot de passe initial<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /><span className="admin-help">12 caractères minimum. Transmettez-le de manière confidentielle à l’utilisateur. Aucun email automatique n’est envoyé.</span></label></> : <p className="admin-help">{member.email}</p>}<label className="field-label">Rôle<select value={role} disabled={lastAdmin} onChange={(event) => setRole(event.target.value as AdminMember["role"])}><option value="member">Membre</option><option value="admin">Administrateur</option></select></label>{!isNew && <label className="field-label">Accès à cet espace<select value={status} disabled={lastAdmin} onChange={(event) => setStatus(event.target.value as AdminMember["status"])}><option value="active">Actif</option><option value="suspended">Suspendu</option><option value="revoked">Accès retiré</option></select></label>}{lastAdmin && <p className="admin-help">Promouvez un autre administrateur avant de modifier votre rôle ou de retirer cet accès.</p>}{status !== "active" && <p className="inline-warning">{status === "revoked" ? "L’utilisateur perdra l’accès à cet espace et ses affectations de lignes seront retirées." : "L’utilisateur perdra l’accès à cet espace. Ses affectations seront conservées pour une réactivation."} Les appels déjà connectés pourront se terminer.</p>}{role === "admin" && <p className="admin-help">Ce rôle permet de gérer tous les utilisateurs, les numéros, les achats et les menus vocaux de l’espace.</p>}</fieldset>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Annuler</button><button className="button button-primary" disabled={busy}>{busy ? "Enregistrement…" : isNew ? "Créer l’utilisateur" : "Enregistrer"}</button></div></form></Modal>;
}

function AssignmentEditor({ line, data, api, base, onClose, onSaved }: { line: AdminLine; data: AdminSnapshot; api: Api; base: string; onClose(): void; onSaved(): Promise<void> }) {
  const [target, setTarget] = useState("");
  const [voice, setVoice] = useState(false);
  const [sms, setSms] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  const eligible = data.members.filter((member) => member.status === "active" || data.assignments.some((a) => a.line_id === line.id && a.user_id === member.user_id && a.status === "active"));
  const existing = data.assignments.find((a) => a.line_id === line.id && a.user_id === target && a.status === "active");
  const targetActive = data.members.find((member) => member.user_id === target)?.status === "active";
  function select(id: string) { setTarget(id); const assignment = data.assignments.find((a) => a.line_id === line.id && a.user_id === id && a.status === "active"); setVoice(assignment?.can_voice ?? false); setSms(assignment?.can_sms ?? false); }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (submitting.current || !target) return; submitting.current = true; setBusy(true); setError("");
    try { await api(`${base}/lines/${line.id}/assignments/${target}`, { method: voice || sms ? "PUT" : "DELETE", ...(voice || sms ? { body: JSON.stringify({ canVoice: voice, canSms: sms }) } : {}) }); await onSaved(); }
    catch (caught) { setError(errorText(caught)); } finally { submitting.current = false; setBusy(false); }
  }
  return <Modal title="Droits sur le numéro" onClose={onClose} busy={busy}><form className="contact-form" onSubmit={submit}><p className="admin-help">{formatPhone(line.phone_number)} · Choisissez un utilisateur puis ses permissions.</p><fieldset className="admin-fieldset" disabled={busy}><label className="field-label">Utilisateur<select required value={target} onChange={(event) => select(event.target.value)}><option value="">Choisir un utilisateur</option>{eligible.map((member) => <option key={member.user_id} value={member.user_id}>{member.display_name}{member.status !== "active" ? ` (${statuses[member.status]})` : ""}</option>)}</select></label><label className="admin-check"><input type="checkbox" checked={voice} disabled={!target || ((!line.voice_enabled || line.status !== "active" || !targetActive) && !voice)} onChange={(event) => setVoice(event.target.checked)} /><span><b>Appels</b><span>Émettre, recevoir et consulter l’historique des appels.</span></span></label><label className="admin-check"><input type="checkbox" checked={sms} disabled={!target || ((!line.sms_enabled || line.status !== "active" || !targetActive) && !sms)} onChange={(event) => setSms(event.target.checked)} /><span><b>SMS</b><span>Envoyer, recevoir et consulter les conversations.</span></span></label></fieldset>{target && existing && !voice && !sms && <p className="inline-warning">L’accès de cet utilisateur à la ligne sera retiré.</p>}{target && line.ivr_config.options.some((option) => option.userId === target) && !voice && <p className="inline-warning">Cet utilisateur est destinataire du menu IVR. Pensez à modifier le menu pour que cette touche puisse recevoir des appels.</p>}{!eligible.length && <p className="admin-help">Créez d’abord un utilisateur actif.</p>}{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>Annuler</button><button className="button button-primary" disabled={busy || !target || (!existing && !voice && !sms) || ((!targetActive || line.status !== "active") && (voice || sms))}>{busy ? "Enregistrement…" : "Enregistrer les droits"}</button></div></form></Modal>;
}

function IvrEditor({ line, data, api, base, onClose, onSaved }: { line: AdminLine; data: AdminSnapshot; api: Api; base: string; onClose(): void; onSaved(): Promise<void> }) {
  const [config, setConfig] = useState<IvrConfig>(() => structuredClone(line.ivr_config ?? defaultIvrConfig));
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  const recipients = data.members.filter((member) => member.status === "active" && data.assignments.some((assignment) => assignment.line_id === line.id && assignment.user_id === member.user_id && assignment.can_voice && assignment.status === "active"));
  function option(index: number, patch: Partial<IvrConfig["options"][number]>) { setConfig((current) => ({ ...current, options: current.options.map((item, position) => position === index ? { ...item, ...patch } : item) })); }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (submitting.current) return;
    const parsed = ivrConfigSchema.safeParse(config);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Vérifiez le menu."); return; }
    submitting.current = true; setBusy(true); setError("");
    try { await api(`${base}/lines/${line.id}/ivr`, { method: "PUT", body: JSON.stringify({ config: parsed.data, version: line.updated_at }) }); await onSaved(); }
    catch (caught) { setError(errorText(caught)); } finally { submitting.current = false; setBusy(false); }
  }
  return <Modal title={`Menu vocal · ${formatPhone(line.phone_number)}`} className="admin-ivr-modal" onClose={onClose} busy={busy}><form className="contact-form" onSubmit={submit}><fieldset className="admin-fieldset" disabled={busy}><label className="admin-check"><input type="checkbox" checked={config.enabled} onChange={(event) => setConfig({ ...config, enabled: event.target.checked })} /><span><b>Activer le menu d’accueil</b><span>{config.enabled ? "L’appelant choisit son interlocuteur avec le clavier." : "Les appels sonnent directement chez les utilisateurs autorisés."}</span></span></label><label className="field-label">Message d’accueil<textarea rows={3} required maxLength={1000} value={config.greeting} onChange={(event) => setConfig({ ...config, greeting: event.target.value })} /><span className="admin-help">Les consignes de chaque touche sont lues automatiquement après ce message.</span></label><div className="admin-form-grid"><label className="field-label">Langue<select value={config.language} onChange={(event) => setConfig({ ...config, language: event.target.value as IvrConfig["language"] })}><option value="fr-FR">Français</option><option value="en-GB">Anglais (Royaume-Uni)</option><option value="en-US">Anglais (États-Unis)</option></select></label><label className="field-label">Attente du choix<select value={config.timeout} onChange={(event) => setConfig({ ...config, timeout: Number(event.target.value) })}>{Array.from({ length: 13 }, (_, index) => index + 3).map((seconds) => <option key={seconds} value={seconds}>{seconds} secondes</option>)}</select></label></div><div className="admin-menu-heading"><h3>Touches du menu</h3><button type="button" className="text-button" disabled={config.options.length >= 10} onClick={() => setConfig({ ...config, options: [...config.options, { digit: ["1","2","3","4","5","6","7","8","9","0"].find((digit) => !config.options.some((item) => item.digit === digit))!, label: "", userId: null }] })}><Plus size={16} />Ajouter une touche</button></div>{config.options.map((item, index) => <div className="admin-ivr-option" key={index}><label className="field-label">Touche<select value={item.digit} onChange={(event) => option(index, { digit: event.target.value })}>{["0","1","2","3","4","5","6","7","8","9"].map((digit) => <option key={digit} disabled={config.options.some((other, position) => position !== index && other.digit === digit)}>{digit}</option>)}</select></label><label className="field-label">Annonce<input placeholder="Ex. le service commercial" required maxLength={80} value={item.label} onChange={(event) => option(index, { label: event.target.value })} /></label><label className="field-label">Faire sonner<select value={item.userId ?? ""} onChange={(event) => option(index, { userId: event.target.value || null })}><option value="">Tous les utilisateurs de la ligne</option>{item.userId && !recipients.some((member) => member.user_id === item.userId) && <option value={item.userId}>Destinataire indisponible — à remplacer</option>}{recipients.map((member) => <option key={member.user_id} value={member.user_id}>{member.display_name}</option>)}</select></label><button type="button" className="icon-button danger-text" aria-label={`Supprimer la touche ${item.digit}`} onClick={() => setConfig({ ...config, options: config.options.filter((_, position) => position !== index) })}><Trash size={18} /></button></div>)}{!config.options.length && <p className="admin-help">Ajoutez au moins une touche pour activer le menu.</p>}<div className="admin-form-grid"><label className="field-label">Nombre de tentatives<select value={config.maxAttempts} onChange={(event) => setConfig({ ...config, maxAttempts: Number(event.target.value) })}>{[1,2,3].map((count) => <option key={count} value={count}>{count}</option>)}</select></label><label className="field-label">Sans choix valide<select value={config.fallback} onChange={(event) => setConfig({ ...config, fallback: event.target.value as IvrConfig["fallback"] })}><option value="all">Faire sonner toute la ligne</option><option value="hangup">Dire au revoir et raccrocher</option></select></label></div><div className="admin-ivr-preview"><span><GitBranch size={17} />Ce que l’appelant entendra</span><p>{config.greeting}</p>{config.options.map((item, index) => <p key={index}>{config.language === "fr-FR" ? `Pour ${item.label || "…"}, tapez ${item.digit}.` : `For ${item.label || "…"}, press ${item.digit}.`}</p>)}</div><p className="admin-help">Les changements s’appliquent aux nouveaux appels. Les menus déjà en cours conservent leur configuration. Si aucun appareil autorisé n’est disponible, l’appelant est informé avant la fin de l’appel.</p></fieldset>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button className="button button-secondary" type="button" disabled={busy} onClick={onClose}>Annuler</button><button className="button button-primary" disabled={busy}>{busy ? "Enregistrement…" : "Enregistrer le menu"}</button></div></form></Modal>;
}
