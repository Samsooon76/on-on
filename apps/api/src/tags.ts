import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { tagInputSchema, tagSettingsInputSchema, tagManualSchema, tagKindSchema, tagCatalogSchema, tagSubjectSchema, type Tag, type Database } from "@onoff/contracts";
import type { AppConfig } from "./config.js";
import { createJevClassifier, type TagClassifier } from "./jev.js";

const uuid = z.string().uuid();
const fail = (message: string, statusCode = 503): never => { throw Object.assign(new Error(message), { statusCode }); };
function checked<T>(result: { data: T; error: { code?: string } | null }): T {
  if (result.error) fail(result.error.code === "23505" ? "Un tag de ce nom existe déjà." : "Les tags sont momentanément indisponibles.", result.error.code === "23505" ? 409 : 503);
  return result.data;
}
const publicTag = (row: any): Tag => ({ id: row.id, organizationId: row.organization_id, name: row.name, color: row.color, kind: row.kind, aiEnabled: row.ai_enabled, prompt: row.prompt, updatedAt: row.updated_at });
const defaults = { calls_enabled: false, confidence_threshold: 0.85, updated_at: null };
const publicSettings = (row: any) => ({ callsEnabled: row.calls_enabled, confidenceThreshold: row.confidence_threshold, updatedAt: row.updated_at });

export function registerTags(app: FastifyInstance, config: AppConfig, service: SupabaseClient<Database> | null, classifier?: TagClassifier): void {
  // New tables are isolated until generated types are refreshed at deployment.
  const db = service as SupabaseClient | null;
  const classify = classifier ?? (config.TYPESAFE_API_KEY ? createJevClassifier(config.TYPESAFE_API_KEY, config.TYPESAFE_MODEL) : null);
  const available = Boolean(db && classify);
  const userDb = (req: FastifyRequest) => req.context!.supabase as SupabaseClient;
  const server = () => db ?? fail("Le service de tags est indisponible.");
  async function membership(req: FastifyRequest, org: string, admin = false) {
    const member = checked(await req.context!.supabase.from("memberships").select("role").eq("organization_id", org).eq("user_id", req.context!.userId).eq("status", "active").maybeSingle());
    if (!member || (admin && member.role !== "admin")) fail(admin ? "Accès administrateur requis." : "Espace introuvable.", 403);
    return member!;
  }
  async function target(req: FastifyRequest) {
    const params = req.params as { kind: string; id: string };
    const kind = tagKindSchema.parse(params.kind), id = uuid.parse(params.id);
    const query = userDb(req).from("calls").select("id,organization_id").eq("id", id);
    const row = checked(await query.maybeSingle());
    if (!row) return fail("Appel introuvable.", 404);
    return { kind, id, org: row.organization_id, column: "call_id" };
  }
  async function ensureSubject(t: Awaited<ReturnType<typeof target>>) {
    checked(await server().from("tag_subjects").upsert({ organization_id: t.org, kind: t.kind, [t.column]: t.id }, { onConflict: t.column, ignoreDuplicates: true }));
    return checked(await server().from("tag_subjects").select("*").eq(t.column, t.id).single());
  }
  async function settings(org: string) { return checked(await server().from("tag_settings").select("*").eq("organization_id", org).maybeSingle()) ?? defaults; }
  async function readSubject(req: FastifyRequest, t: Awaited<ReturnType<typeof target>>) {
    const subject = checked(await userDb(req).from("tag_subjects").select("*").eq(t.column, t.id).maybeSingle());
    const assignments = subject ? checked(await userDb(req).from("tag_assignments").select("source,confidence,tags(*)").eq("subject_id", subject.id).eq("excluded", false)) : [];
    return tagSubjectSchema.parse({ organizationId: t.org, status: subject?.status ?? "idle", message: subject?.message ?? null,
      assignments: (assignments ?? []).filter((a: any) => a.tags).map((a: any) => ({ tag: publicTag(a.tags), source: a.source, confidence: a.confidence })) });
  }
  app.get("/v1/organizations/:id/tags", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const org = uuid.parse((req.params as { id: string }).id), member = await membership(req, org);
    const [items, cfg] = await Promise.all([
      userDb(req).from("tags").select("*").eq("organization_id", org).order("name"),
      userDb(req).from("tag_settings").select("*").eq("organization_id", org).maybeSingle(),
    ]);
    return tagCatalogSchema.parse({ items: (checked(items) ?? []).map(publicTag), settings: publicSettings(checked(cfg) ?? defaults), providerAvailable: available, canManage: member.role === "admin" });
  });
  app.put("/v1/organizations/:id/tag-settings", async req => {
    const org = uuid.parse((req.params as { id: string }).id); await membership(req, org, true);
    const input = tagSettingsInputSchema.parse(req.body);
    const previous = await settings(org);
    if ((input.callsEnabled && !previous.calls_enabled) && !available) fail("Configurez TYPESAFE_API_KEY sur le serveur pour activer l’IA.", 409);
    const row = checked(await server().from("tag_settings").upsert({ organization_id: org, calls_enabled: input.callsEnabled, confidence_threshold: input.confidenceThreshold, updated_at: new Date().toISOString() }).select("*").single());
    return publicSettings(row);
  });
  app.post("/v1/organizations/:id/tags", async (req, reply) => {
    const org = uuid.parse((req.params as { id: string }).id); await membership(req, org, true);
    const input = tagInputSchema.parse(req.body);
    const existing = checked(await server().from("tags").select("id").eq("organization_id", org).eq("kind", input.kind));
    if ((existing?.length ?? 0) >= 100) fail("La limite est de 100 tags par catégorie.", 409);
    const row = checked(await server().from("tags").insert({ organization_id: org, name: input.name, color: input.color, kind: input.kind, ai_enabled: input.aiEnabled, prompt: input.prompt }).select("*").single());
    reply.code(201); return publicTag(row);
  });
  app.put("/v1/tags/:id", async req => {
    const id = uuid.parse((req.params as { id: string }).id), input = tagInputSchema.parse(req.body);
    const previous = checked(await userDb(req).from("tags").select("*").eq("id", id).maybeSingle());
    if (!previous) fail("Tag introuvable.", 404);
    await membership(req, previous.organization_id, true);
    if (input.kind !== previous.kind) fail("Le type d’un tag existant ne peut pas changer.", 409);
    return publicTag(checked(await server().from("tags").update({ name: input.name, color: input.color, ai_enabled: input.aiEnabled, prompt: input.prompt }).eq("id", id).select("*").single()));
  });
  app.delete("/v1/tags/:id", async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const tag = checked(await userDb(req).from("tags").select("organization_id").eq("id", id).maybeSingle());
    if (!tag) return fail("Tag introuvable.", 404);
    await membership(req, tag.organization_id, true);
    checked(await server().from("tags").delete().eq("id", id)); return reply.code(204).send();
  });
  app.get("/v1/tagging/:kind/:id", async (req, reply) => { reply.header("cache-control", "no-store"); return readSubject(req, await target(req)); });
  app.put("/v1/tagging/:kind/:id/tags/:tagId", async req => {
    const t = await target(req), tagId = uuid.parse((req.params as { tagId: string }).tagId), input = tagManualSchema.parse(req.body);
    const tag = checked(await userDb(req).from("tags").select("id").eq("id", tagId).eq("organization_id", t.org).eq("kind", t.kind).maybeSingle());
    if (!tag) return fail("Tag incompatible ou introuvable.", 404);
    const subject = await ensureSubject(t);
    checked(await server().from("tag_assignments").upsert({ subject_id: subject.id, tag_id: tagId, organization_id: t.org, kind: t.kind, source: "manual", excluded: !input.assigned, confidence: null }));
    return readSubject(req, t);
  });
  app.post("/v1/tagging/:kind/:id/classify", async (req, reply) => {
    const t = await target(req);
    if (!available) fail("Jev n’est pas configuré sur le serveur.", 409);
    if (config.OPERATIONS_PAUSED) fail(config.OPERATIONS_PAUSE_MESSAGE);
    if (!(await settings(t.org)).calls_enabled) fail("Activez l’IA pour les appels dans les réglages.", 409);
    const limited = checked(await server().rpc("consume_api_rate_limit", { p_user_id: req.context!.userId, p_operation: "tag_classify", p_window_seconds: 60, p_max_requests: 10 }));
    if (!limited) fail("Patientez avant de relancer l’analyse.", 429);
    const subject = await ensureSubject(t);
    if (!["pending", "processing"].includes(subject.status)) checked(await server().from("tag_subjects").update({ status: "pending", lease: null, attempts: 0, retry_at: new Date().toISOString(), message: null }).eq("id", subject.id).eq("status", subject.status));
    void drain().catch(() => undefined);
    reply.code(202); return readSubject(req, t);
  });

  async function processJob(job: any) {
    let cfg: any = defaults;
    async function finish(status: string, message: string | null, tagId: string | null = null, confidence: number | null = null) {
      checked(await server().rpc("finish_tag_job", { p_id: job.id, p_lease: job.lease, p_revision: cfg.updated_at, p_tag: tagId, p_confidence: confidence, p_status: status, p_message: message }));
    }
    try {
      if (job.attempts > 3) { await finish("error", "L’analyse a été interrompue plusieurs fois. Relancez-la manuellement."); return; }
      cfg = await settings(job.organization_id);
      if (!cfg.calls_enabled) { await finish("skipped", "L’IA est désactivée pour les appels."); return; }
      const tags = (checked(await server().from("tags").select("*").eq("organization_id", job.organization_id).eq("kind", job.kind).eq("ai_enabled", true)) ?? []).map(publicTag);
      if (!tags.length) { await finish("skipped", "Créez un tag avec un prompt et activez son IA."); return; }
      const transcript = checked(await server().from("call_transcriptions").select("status,snapshot").eq("call_id", job.call_id).maybeSingle());
      if (!transcript || transcript.status !== "completed" || !transcript.snapshot?.segments?.length) { await finish("skipped", "Une transcription terminée est nécessaire pour classer cet appel."); return; }
      const state = { transcript: transcript.snapshot.segments.map((segment: any) => ({ speaker: segment.speaker, text: segment.text })) };
      const decision = await classify!(state, tags, cfg.confidence_threshold);
      await finish("completed", decision.tagId ? "Analyse terminée. Vos choix manuels sont prioritaires." : "Aucun tag suffisamment certain. Vous pouvez choisir manuellement.", decision.tagId, decision.confidence);
    } catch (error) {
      await finish(job.attempts < 3 ? "pending" : "error", error instanceof Error ? error.message : "L’analyse a échoué.");
    }
  }
  let draining: Promise<void> | null = null, closing = false;
  function drain(): Promise<void> {
    if (!available || config.OPERATIONS_PAUSED || closing) return Promise.resolve();
    if (draining) return draining;
    draining = (async () => {
      for (let i = 0; i < 5 && !closing; i++) {
        const jobs = checked(await server().rpc("claim_tag_job"));
        if (!jobs?.[0]) break;
        await processJob(jobs[0]);
      }
    })().finally(() => { draining = null; });
    return draining;
  }
  const timer = available ? setInterval(() => { void drain().catch(() => app.log.warn("Tag queue unavailable")); }, 5000) : null;
  timer?.unref();
  app.addHook("onClose", async () => { closing = true; if (timer) clearInterval(timer); await draining?.catch(() => undefined); });
}
