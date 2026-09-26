import { useEffect, useMemo, useState } from "react";
import { Alert, AppState, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { createTagClient, tagStatus, type TagApi } from "@onoff/api-client";
import { tagInputSchema, type Tag, type TagCatalog, type TagInput, type TagKind, type TagSubject } from "@onoff/api-client";
import { ActionButton, Card, IconButton, Pill, Sheet, Touch, palette, styles } from "./ui";
const blank: TagInput = { name: "", kind: "call", color: "#246653", aiEnabled: false, prompt: "" };
const errorText = (e: unknown) => e instanceof Error ? e.message : "La demande a échoué.";
const colors = ["#246653", "#3869A4", "#8453A1", "#AD6336", "#AB4545", "#657068"];
export function TagManager({ api, organizationId }: { api: TagApi; organizationId: string }) {
  const client = useMemo(() => createTagClient(api), [api]);
  const [catalog, setCatalog] = useState<TagCatalog | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [revision, setRevision] = useState(0), [threshold, setThreshold] = useState("85");
  const [draft, setDraft] = useState<TagInput | null>(null), [editing, setEditing] = useState<Tag | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void client.catalog(organizationId, controller.signal).then(data => { if (!controller.signal.aborted) { setCatalog(data); setThreshold(String(Math.round(data.settings.confidenceThreshold * 100))); setError(""); } }).catch(e => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => controller.abort();
  }, [client, organizationId, revision]);
  async function run(action: () => Promise<unknown>) { setBusy(true); setError(""); try { await action(); setRevision(v => v + 1); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }
  const errorView = error ? <Text accessibilityRole="alert" style={[styles.hint, { color: palette.red }]}>{error}</Text> : null;
  return <View><Text style={styles.settingsLabel}>AI CALL TAG</Text><Card>
    <Text style={styles.rowTitle}>Vos catégories, vos critères</Text><Text style={styles.hint}>Créez vos tags et leurs prompts. Une fois activé, Jev analyse la transcription pour classer chaque appel.</Text>
    {errorView}{!catalog && <ActionButton label={error ? "Réessayer" : "Chargement…"} quiet disabled={!error} onPress={() => setRevision(v => v + 1)} />}
    {catalog && <>
      {!catalog.providerAvailable && <Text style={styles.hint}>Jev n’est pas connecté. Les tags manuels et les prompts restent disponibles.</Text>}
      <View style={styles.listRow}><Text style={[styles.rowTitle, styles.rowCopy]}>Activer AI call tag</Text><Switch accessibilityLabel="Activer AI call tag" value={catalog.settings.callsEnabled} disabled={busy || !catalog.canManage || (!catalog.providerAvailable && !catalog.settings.callsEnabled)} onValueChange={callsEnabled => void run(() => client.settings(organizationId, { callsEnabled, confidenceThreshold: catalog.settings.confidenceThreshold }))} trackColor={{ true: palette.accent }} /></View>
      <Text style={styles.hint}>À la fin de la transcription, celle-ci et les prompts des tags sont envoyés à TypeSafe AI. Les tags existants sont conservés à la désactivation.</Text>
      <Text style={styles.fieldLabel}>Confiance minimale (50 à 99 %)</Text><View style={styles.actionRow}><TextInput accessibilityLabel="Confiance minimale en pourcentage" editable={catalog.canManage && !busy} keyboardType="number-pad" maxLength={2} style={[styles.input, { width: 75, marginBottom: 0 }]} value={threshold} onChangeText={setThreshold} /><ActionButton label="Enregistrer" quiet disabled={busy || !catalog.canManage || Number(threshold) < 50 || Number(threshold) > 99 || Number(threshold) === Math.round(catalog.settings.confidenceThreshold * 100)} onPress={() => void run(() => client.settings(organizationId, { callsEnabled: catalog.settings.callsEnabled, confidenceThreshold: Number(threshold) / 100 }))} /></View>
      {!catalog.items.length && <Text style={styles.hint}>Aucun tag. Commencez par « À rappeler » ou « Demande de devis ».</Text>}
      {catalog.items.map(tag => <View key={tag.id} style={styles.listRow}><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tag.color }} /><View style={styles.rowCopy}><Text style={styles.rowTitle}>{tag.name}</Text><Text style={styles.rowMeta}>{tag.aiEnabled ? "IA activée" : "Manuel"}</Text>{!!tag.prompt && <Text numberOfLines={2} style={styles.rowMeta}>{tag.prompt}</Text>}</View>{catalog.canManage && <><IconButton icon="create-outline" label={`Modifier ${tag.name}`} disabled={busy} onPress={() => { setEditing(tag); setDraft({ name: tag.name, color: tag.color, kind: tag.kind, aiEnabled: tag.aiEnabled, prompt: tag.prompt }); }} /><IconButton icon="trash-outline" label={`Supprimer ${tag.name}`} disabled={busy} onPress={() => Alert.alert(`Supprimer ${tag.name} ?`, "Ses attributions seront aussi supprimées.", [{ text: "Annuler", style: "cancel" }, { text: "Supprimer", style: "destructive", onPress: () => void run(() => client.remove(tag.id)) }])} /></>}</View>)}
      {catalog.canManage ? <ActionButton label="Créer un tag" icon="add" disabled={busy} onPress={() => { setEditing(null); setDraft({ ...blank }); }} /> : <Text style={styles.hint}>Les réglages sont gérés par votre administrateur.</Text>}
    </>}
  </Card>
  <Sheet visible={Boolean(draft)} title={editing ? "Modifier le tag" : "Nouveau tag"} closeDisabled={busy} onClose={() => setDraft(null)}>{draft && <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    {errorView}<Text style={styles.fieldLabel}>Nom du tag</Text><TextInput accessibilityLabel="Nom du tag" style={styles.input} value={draft.name} onChangeText={name => setDraft({ ...draft, name })} maxLength={60} placeholder="Demande de devis" />
    <View style={styles.actionRow}>{colors.map(color => <Touch key={color} accessibilityLabel={`Couleur ${color}`} accessibilityState={{ selected: draft.color === color }} onPress={() => setDraft({ ...draft, color })} style={{ width: 44, height: 44, borderWidth: draft.color === color ? 3 : 0, borderColor: palette.ink, borderRadius: 22, backgroundColor: color }}><Text>{draft.color === color ? "✓" : ""}</Text></Touch>)}</View>
    <View style={styles.actionRow}><Text style={[styles.rowTitle, styles.rowCopy]}>Attribution par IA</Text><Switch accessibilityLabel="Attribution par IA" value={draft.aiEnabled} onValueChange={aiEnabled => setDraft({ ...draft, aiEnabled })} /></View>
    <Text style={styles.fieldLabel}>Consigne pour ce tag</Text><TextInput accessibilityLabel="Consigne pour ce tag" style={[styles.input, styles.multiline]} multiline maxLength={2000} value={draft.prompt} onChangeText={prompt => setDraft({ ...draft, prompt })} placeholder="Le client demande un prix ou un devis pour un projet précis…" />
    <ActionButton label="Enregistrer le tag" loading={busy} onPress={() => { const result = tagInputSchema.safeParse(draft); if (!result.success) { setError(result.error.issues[0]?.message ?? "Vérifiez le tag."); return; } void run(async () => { await client.save(organizationId, result.data, editing?.id); setDraft(null); }); }} />
  </ScrollView>}</Sheet></View>;
}

export function SubjectTags({ api, kind, id }: { api: TagApi; kind: TagKind; id: string }) {
  const client = useMemo(() => createTagClient(api), [api]);
  const [data, setData] = useState<TagSubject | null>(null), [catalog, setCatalog] = useState<TagCatalog | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let controller = new AbortController(), timer: ReturnType<typeof setTimeout>;
    async function load() {
      const signal = controller.signal;
      try {
        const next = await client.subject(kind, id, signal);
        if (signal.aborted) return;
        setData(next);
        const list = await client.catalog(next.organizationId, signal);
        if (signal.aborted) return;
        setCatalog(list); setError("");
        timer = setTimeout(() => void load(), ["pending", "processing"].includes(next.status) ? 2000 : 15000);
      } catch (e) { if (!signal.aborted) { setData(null); setCatalog(null); setError(errorText(e)); } }
    }
    void load();
    const subscription = AppState.addEventListener("change", state => { controller.abort(); clearTimeout(timer); if (state === "active") { controller = new AbortController(); void load(); } });
    return () => { controller.abort(); clearTimeout(timer); subscription.remove(); };
  }, [client, kind, id, revision]);
  async function run(action: () => Promise<TagSubject>) { setBusy(true); setError(""); try { setData(await action()); setRevision(v => v + 1); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }
  const active = Boolean(catalog?.providerAvailable && catalog.settings.callsEnabled);
  return <View style={{ padding: 16, borderBottomWidth: 1, borderColor: palette.line }}>
    <Touch accessibilityLabel="Afficher les tags" accessibilityState={{ expanded }} onPress={() => setExpanded(v => !v)} style={styles.actionRow}><Text style={styles.rowTitle}>AI call tag</Text><Text style={styles.rowMeta}>{data?.assignments.map(a => a.tag.name).join(" · ") || "Aucun tag"} {expanded ? "⌃" : "⌄"}</Text></Touch>
    {expanded && <ScrollView style={{ maxHeight: 220 }} keyboardShouldPersistTaps="handled">
      {!!error && <><Text accessibilityRole="alert" style={[styles.hint, { color: palette.red }]}>{error}</Text><ActionButton quiet label="Réessayer" onPress={() => setRevision(v => v + 1)} /></>}
      {data && <>
        <View style={[styles.actionRow, { marginTop: 12 }]}>{catalog?.items.filter(tag => tag.kind === kind).map(tag => { const assignment = data.assignments.find(a => a.tag.id === tag.id); return <Pill key={tag.id} label={`${tag.name}${assignment?.source === "ai" ? " · IA" : ""}`} selected={Boolean(assignment)} disabled={busy} onPress={() => void run(() => client.assign(kind, id, tag.id, !assignment))} />; })}</View>
        {!catalog?.items.some(t => t.kind === kind) && <Text style={styles.hint}>Créez des tags dans les réglages.</Text>}
        <Text accessibilityLiveRegion="polite" style={styles.hint}>{data.message ?? (active ? tagStatus[data.status] : "IA désactivée. Les tags manuels restent disponibles.")}</Text>
        <ActionButton label="Analyser avec l’IA" quiet icon="sparkles-outline" disabled={busy || !active || ["pending", "processing"].includes(data.status)} onPress={() => void run(() => client.classify(kind, id))} />
      </>}
    </ScrollView>}
  </View>;
}
