import { useMemo, useRef, useState } from "react";
import { ArrowRight, DownloadSimple, UploadSimple } from "@phosphor-icons/react";
import { Modal } from "./ui";
import { MAX_DIALER_CONTACTS, outcomes, settingsError, type DialerContact, type DialerSettings, type DialerState, type QueueEntry, type RetryOutcome } from "./powerdialer-model";
import { csvTemplate, csvText, MAX_CSV_BYTES, parseDialerCsv, prepareCsvImport, suggestCsvMapping, type CsvMapping } from "./powerdialer-csv";

export function downloadDialerFile(content: string, filename: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename;
  anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function formatScheduledDate(at: string) { return new Date(at).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); }

export function CsvImport({ existing, excluded, onClose, onAdd }: { existing: string[]; excluded: string[]; onClose(): void; onAdd(contacts: DialerContact[], name: string): void }) {
  const [raw, setRaw] = useState("");
  const [filename, setFilename] = useState("");
  const [hasHeader, setHasHeader] = useState(true);
  const [nationalFormat, setNationalFormat] = useState<"FR" | "international">("FR");
  const [mapping, setMapping] = useState<CsvMapping>(suggestCsvMapping([]));
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const request = useRef(0);
  const parsed = useMemo(() => { if (!raw) return null; try { return { data: parseDialerCsv(raw, hasHeader), error: "" }; } catch (error) { return { data: null, error: (error as Error).message }; } }, [raw, hasHeader]);
  const preview = useMemo(() => parsed?.data ? prepareCsvImport(parsed.data, mapping, existing, excluded, nationalFormat, filename) : null, [parsed, mapping, existing, excluded, nationalFormat, filename]);
  const overLimit = (preview?.contacts.length ?? 0) + existing.length > MAX_DIALER_CONTACTS;
  const mappingValues = Object.values(mapping).filter((column) => column >= 0);
  const mappingDuplicate = new Set(mappingValues).size !== mappingValues.length;
  async function readFile(file?: File) {
    const version = ++request.current;
    setRaw(""); setError(""); setFilename("");
    if (!file) return;
    if (file.size > MAX_CSV_BYTES) { setError("Le fichier dépasse 2 Mo. Scindez-le en plusieurs fichiers."); setReading(false); return; }
    setReading(true);
    try {
      const text = await file.text();
      if (version !== request.current) return;
      setRaw(text); setFilename(file.name);
      // Retain the file when its header interpretation is wrong, so toggling
      // the header option can recover a one-line, headerless export.
      try { setMapping(suggestCsvMapping(parseDialerCsv(text, hasHeader).headers)); }
      catch { setMapping(suggestCsvMapping([])); }
    } catch (error) { if (version === request.current) setError(error instanceof Error ? error.message : "Impossible de lire ce fichier."); }
    finally { if (version === request.current) setReading(false); }
  }
  return <Modal title="Importer une liste CSV" className="pd-import-modal" onClose={onClose}>
    <p className="pd-modal-description">Ajoutez jusqu’à 1 000 numéros par campagne. Vérifiez les colonnes et l’aperçu avant l’import. Les contacts restent dans cette campagne.</p>
    <label className="pd-upload" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void readFile(event.dataTransfer.files[0]); }}>
      <UploadSimple size={27} /><strong>{reading ? "Lecture du fichier…" : filename || "Choisir ou glisser un fichier CSV"}</strong><span>CSV UTF-8 · virgule, point-virgule ou tabulation · 2 Mo max.</span>
      <input type="file" accept=".csv,text/csv,text/tab-separated-values" aria-label="Fichier CSV" onChange={(event) => { void readFile(event.target.files?.[0]); event.target.value = ""; }} />
    </label>
    <div className="pd-import-toolbar"><label><input type="checkbox" checked={hasHeader} onChange={(event) => {
      setError(""); setHasHeader(event.target.checked);
      if (raw) { try { setMapping(suggestCsvMapping(parseDialerCsv(raw, event.target.checked).headers)); } catch { /* displayed below */ } }
    }} />Première ligne = en-têtes</label><button className="text-button" onClick={() => downloadDialerFile(csvTemplate, "modele-powerdialer.csv")}><DownloadSimple size={15} />Modèle CSV</button></div>
    {(error || parsed?.error) && <p role="alert" className="pd-error">{error || parsed?.error}</p>}
    {parsed?.data && <>
      <div className="pd-form-grid">
        {([["phone", "Téléphone *"], ["name", "Nom / nom complet"], ["firstName", "Prénom"], ["company", "Entreprise"], ["email", "Email"], ["notes", "Notes"]] as const).map(([field, label]) => <label key={field}>{label}<select value={mapping[field]} onChange={(event) => setMapping({ ...mapping, [field]: Number(event.target.value) })}><option value={-1}>{field === "phone" ? "Choisir une colonne" : "Ne pas importer"}</option>{parsed.data!.headers.map((name, index) => <option key={index} value={index}>{index + 1}. {name}</option>)}</select></label>)}
      </div>
      <label className="pd-field">Numéros sans indicatif<select value={nationalFormat} onChange={(event) => setNationalFormat(event.target.value as "FR" | "international")}><option value="FR">France · 06… devient +336…</option><option value="international">Exiger + ou 00 et l’indicatif du pays</option></select></label>
      <p className="pd-form-hint">Les numéros internationaux avec + ou 00 sont conservés. Les numéros tronqués par Excel doivent être corrigés dans le fichier.</p>
      {mapping.phone < 0 && <p className="pd-error">Associez la colonne téléphone pour préparer l’import.</p>}
      {mappingDuplicate && <p className="pd-error" role="alert">Chaque colonne ne peut être associée qu’à un seul champ.</p>}
      {preview && mapping.phone >= 0 && <>
        <div className="pd-import-counts" role="status"><span><strong>{preview.contacts.length}</strong> à importer</span><span>{preview.duplicates} doublons</span><span>{preview.invalid} invalides</span><span>{preview.excluded} exclus</span></div>
        <div className="pd-table-scroll"><table className="pd-preview-table"><caption>Aperçu des {Math.min(5, preview.contacts.length)} premiers contacts valides</caption><thead><tr><th>Contact</th><th>Téléphone</th><th>Entreprise</th></tr></thead><tbody>{preview.contacts.slice(0, 5).map((contact) => <tr key={contact.number}><td>{contact.name}</td><td>{contact.number}</td><td>{contact.company || "—"}</td></tr>)}</tbody></table></div>
        {preview.issues.length > 0 && <details className="pd-import-issues"><summary>{preview.issues.length} lignes écartées · voir les raisons</summary>{preview.issues.slice(0, 8).map((issue) => <p key={issue.line}>Ligne {issue.line} : {issue.reason} ({issue.number || "vide"})</p>)}<button className="text-button" onClick={() => downloadDialerFile(csvText([["Ligne", "Numéro", "Motif"], ...preview.issues.map((issue) => [issue.line, issue.number, issue.reason])]), "erreurs-import.csv")}>Télécharger le rapport complet</button></details>}
      </>}
      {overLimit && <p role="alert" className="pd-error">Il reste {MAX_DIALER_CONTACTS - existing.length} places dans cette campagne. Réduisez le fichier avant de l’importer.</p>}
    </>}
    <div className="modal-actions"><button className="button button-secondary" onClick={onClose}>Annuler</button><button className="button button-primary" disabled={reading || !preview?.contacts.length || overLimit || mappingDuplicate} onClick={() => preview && onAdd(preview.contacts, filename.replace(/\.csv$/i, "").slice(0, 100))}>Importer {preview?.contacts.length || "les"} contacts<ArrowRight size={16} /></button></div>
  </Modal>;
}

export function DialerSettingsDialog({ settings, exclusions, onClose, onSave }: { settings: DialerSettings; exclusions: number; onClose(): void; onSave(settings: DialerSettings): void }) {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [error, setError] = useState("");
  const setRetry = (key: RetryOutcome, value: number | null) => setDraft({ ...draft, retryMinutes: { ...draft.retryMinutes, [key]: value } });
  return <Modal title="Réglages de la campagne" className="pd-settings-modal" onClose={onClose}>
    <form onSubmit={(event) => { event.preventDefault(); const error = settingsError(draft); setError(error); if (!error) onSave(draft); }}>
      <label className="pd-field">Nom de la campagne<input required maxLength={100} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <fieldset className="pd-settings-section"><legend>Rythme d’appel</legend><label className="pd-checkbox"><input type="checkbox" checked={draft.autoAdvance} onChange={(event) => setDraft({ ...draft, autoAdvance: event.target.checked })} />Enchaîner après qualification</label><label className="pd-field">Pause entre deux appels (secondes)<input type="number" min={3} max={120} required value={draft.delay} onChange={(event) => setDraft({ ...draft, delay: Number(event.target.value) })} /></label></fieldset>
      <fieldset className="pd-settings-section"><legend>Relances automatiques</legend><label className="pd-checkbox"><input type="checkbox" checked={draft.retryEnabled} onChange={(event) => setDraft({ ...draft, retryEnabled: event.target.checked })} />Replacer les contacts injoignables dans la file</label>
        <div className="pd-form-grid"><label>Tentatives maximum par numéro<input type="number" required min={1} max={10} value={draft.maxAttempts} onChange={(event) => setDraft({ ...draft, maxAttempts: Number(event.target.value) })} /></label><label>Priorité<select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value as DialerSettings["priority"] })}><option value="new-first">Nouveaux contacts d’abord</option><option value="retries-first">Relances dues d’abord</option></select></label></div>
        <p className="pd-form-hint">Premier appel inclus. Les rappels explicitement demandés sont prioritaires et indépendants de cette limite.</p>
        {([["no-answer", "Sans réponse"], ["busy", "Occupé"], ["voicemail", "Répondeur"]] as const).map(([key, label]) => <div key={key} className="pd-retry-rule"><label className="pd-checkbox"><input type="checkbox" disabled={!draft.retryEnabled} checked={draft.retryMinutes[key] !== null} onChange={(event) => setRetry(key, event.target.checked ? 60 : null)} />{label}</label><label>Après<input aria-label={`Délai de relance ${label.toLowerCase()} en minutes`} type="number" min={1} max={43200} required disabled={!draft.retryEnabled || draft.retryMinutes[key] === null} value={draft.retryMinutes[key] ?? 60} onChange={(event) => setRetry(key, Number(event.target.value))} />min</label></div>)}
        <p className="pd-form-hint">Intéressé, pas intéressé, mauvais numéro et ne plus appeler ne déclenchent jamais de relance. Les changements s’appliquent aux prochains résultats ; désactiver une règle annule ses relances en attente.</p>
      </fieldset>
      <fieldset className="pd-settings-section"><legend>Horaires de la campagne</legend><label className="pd-checkbox"><input type="checkbox" checked={draft.hours.enabled} onChange={(event) => setDraft({ ...draft, hours: { ...draft.hours, enabled: event.target.checked } })} />Limiter les appels à ces horaires</label>
        <div className="pd-form-grid"><label>Début<input type="time" required value={draft.hours.start} onChange={(event) => setDraft({ ...draft, hours: { ...draft.hours, start: event.target.value } })} /></label><label>Fin<input type="time" required value={draft.hours.end} onChange={(event) => setDraft({ ...draft, hours: { ...draft.hours, end: event.target.value } })} /></label></div>
        <label className="pd-field">Fuseau horaire<input required list="pd-timezones" value={draft.hours.timeZone} onChange={(event) => setDraft({ ...draft, hours: { ...draft.hours, timeZone: event.target.value } })} /><datalist id="pd-timezones">{["Europe/Paris", "Europe/London", "Europe/Brussels", "Europe/Zurich", "America/Montreal", "America/New_York", "America/Los_Angeles", "Africa/Casablanca", "UTC"].map((zone) => <option key={zone} value={zone} />)}</datalist></label>
        <div className="pd-days">{[[1, "Lun"], [2, "Mar"], [3, "Mer"], [4, "Jeu"], [5, "Ven"], [6, "Sam"], [0, "Dim"]].map(([day, label]) => <label key={day}><input type="checkbox" checked={draft.hours.days.includes(Number(day))} onChange={(event) => setDraft({ ...draft, hours: { ...draft.hours, days: event.target.checked ? [...draft.hours.days, Number(day)] : draft.hours.days.filter((value) => value !== day) } })} />{label}</label>)}</div>
        <p className="pd-form-hint">Même horaire pour tous les contacts, rappels compris. Un appel déjà en cours continue après l’heure de fin.</p>
      </fieldset>
      <label className="pd-field">Script d’appel (facultatif)<textarea maxLength={5000} rows={4} value={draft.script} placeholder="Votre introduction, les questions à poser…" onChange={(event) => setDraft({ ...draft, script: event.target.value })} /></label>
      <p className="pd-form-hint">{exclusions} numéro(s) « Ne plus appeler » exclus pour ce compte, cette organisation et cette ligne sur ce navigateur. L’exclusion persiste après avoir vidé la campagne.</p>
      {error && <p className="pd-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Annuler</button><button type="submit" className="button button-primary">Enregistrer les réglages</button></div>
    </form>
  </Modal>;
}

export function CallbackDialog({ name, initial, onClose, onSave }: { name: string; initial?: string | undefined; onClose(): void; onSave(at: string): void }) {
  const localValue = (value: Date) => new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const [value, setValue] = useState(initial ? localValue(new Date(initial)) : localValue(new Date(Date.now() + 3600_000)));
  const [error, setError] = useState("");
  return <Modal title={`Rappeler ${name}`} className="pd-callback-modal" onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); const date = new Date(value); if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) { setError("Choisissez une date dans le futur."); return; } onSave(date.toISOString()); }}>
    <p className="pd-modal-description">Le contact revient en priorité à partir de cette date, pendant les horaires autorisés. La campagne doit être ouverte et reprise pour appeler.</p>
    <label className="pd-field">Date et heure de rappel<input required type="datetime-local" min={localValue(new Date())} value={value} onChange={(event) => setValue(event.target.value)} /></label><p className="pd-form-hint">Heure de votre navigateur : {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
    {error && <p className="pd-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Annuler</button><button type="submit" className="button button-primary">Programmer le rappel</button></div>
  </form></Modal>;
}

export function dialerReportCsv(state: DialerState): string {
  return csvText([["Campagne", "Contact", "Téléphone", "Entreprise", "Email", "Source", "Statut", "Tentative", "Début", "Fin", "Résultat", "Notes de la tentative", "Notes du contact", "Prochain appel", "Intention"], ...state.entries.flatMap((entry) => (entry.attempts.length ? entry.attempts : [null]).map((attempt, index) => [state.settings.name, entry.name, entry.number, entry.company, entry.email, entry.source, entry.status, attempt ? index + 1 : 0, attempt?.attemptedAt, attempt?.endedAt, outcomes.find((outcome) => outcome.id === attempt?.outcome)?.label, attempt?.notes, entry.notes, entry.nextAttemptAt, attempt?.intentId]))]);
}
export function entryStatus(entry: QueueEntry): string {
  if (entry.status === "scheduled") return `${entry.scheduleKind === "callback" ? "Rappel" : "Relance"} · ${formatScheduledDate(entry.nextAttemptAt!)}`;
  return outcomes.find((outcome) => outcome.id === entry.outcome)?.label ?? (entry.status === "skipped" ? "Ignoré" : entry.status === "pending" ? "À appeler" : "À qualifier");
}
