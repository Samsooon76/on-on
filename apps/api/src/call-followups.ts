import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { callFollowupInputSchema, type Database, type CallFollowupInput } from "@onoff/contracts";

const uuid = z.string().uuid();
const fail = (message: string, statusCode = 503): never => { throw Object.assign(new Error(message), { statusCode }); };
function checked<T>(result: { data: T; error: { code?: string } | null }): T {
  if (result.error) fail(result.error.code === "42501" ? "Vous n’avez plus accès à cet appel." : "Impossible de charger ou d’enregistrer ce suivi.", result.error.code === "42501" ? 403 : 503);
  return result.data;
}
const selection = "id,kind,title,description,priority,amount,status,call_id,contact_id,created_at,calls!inner(remote_number)";
const publicRow = (row: any) => { const { calls, ...item } = row; return { ...item, remote_number: calls.remote_number }; };
const cursorSchema = z.object({ at: z.string().datetime({ offset: true }), id: uuid });

export function registerCallFollowups(app: FastifyInstance, service: SupabaseClient<Database> | null) {
  // User clients apply call RLS to every read and write. Only provider ID resolution uses the server client.
  const db = (req: FastifyRequest) => req.context!.supabase as SupabaseClient;
  async function membership(req: FastifyRequest, org: string) {
    const member = checked(await req.context!.supabase.from("memberships").select("role").eq("organization_id", org).eq("user_id", req.context!.userId).eq("status", "active").maybeSingle());
    if (!member) fail("Espace introuvable.", 403);
  }
  async function resolveCall(req: FastifyRequest, org: string, input: CallFollowupInput) {
    let callId = input.callId;
    if (!callId) {
      if (!service) fail("Le service d’appel est indisponible.");
      let sid = input.providerCallSid;
      if (!sid && input.intentId) {
        const intent = checked(await service!.from("call_intents").select("consumed_call_sid").eq("id", input.intentId).eq("organization_id", org).eq("user_id", req.context!.userId).maybeSingle());
        sid = intent?.consumed_call_sid ?? undefined;
      }
      if (sid) callId = checked(await service!.from("call_legs").select("call_id").eq("organization_id", org).eq("provider_call_sid", sid).maybeSingle())?.call_id;
    }
    if (!callId) fail("L’appel se synchronise ou n’est plus accessible. Conservez le formulaire et réessayez dans un instant.", 409);
    const call = checked(await req.context!.supabase.from("calls").select("id,remote_number").eq("organization_id", org).eq("id", callId!).maybeSingle());
    if (!call) fail("Appel introuvable ou accès retiré.", 404);
    return call!;
  }

  app.post("/v1/organizations/:orgId/call-followups", async (req, reply) => {
    const org = uuid.parse((req.params as { orgId: string }).orgId);
    const input = callFollowupInputSchema.parse(req.body);
    await membership(req, org);
    const call = await resolveCall(req, org, input);
    if (input.contactId) {
      const contact = checked(await req.context!.supabase.from("contacts").select("id").eq("organization_id", org).eq("id", input.contactId).is("archived_at", null).maybeSingle());
      if (!contact) fail("Ce contact n’est plus disponible dans cet espace.", 400);
    }
    const row = { id: input.id, organization_id: org, call_id: call.id, contact_id: input.contactId, created_by: req.context!.userId,
      kind: input.kind, title: input.title, description: input.description, priority: input.priority, amount: input.amount };
    const result = await db(req).from("call_followups").insert(row).select(selection).single();
    if (result.error?.code === "23505") {
      const existing = checked(await db(req).from("call_followups").select(`${selection},organization_id,created_by`).eq("organization_id", org).eq("id", input.id).maybeSingle());
      if (!existing || (Object.keys(row) as (keyof typeof row)[]).some(key => existing[key] !== row[key])) return fail("Ce formulaire a déjà été enregistré avec d’autres informations. Fermez-le pour en créer un nouveau.", 409);
      const { organization_id: _org, created_by: _creator, ...item } = existing;
      return publicRow(item);
    }
    return reply.code(201).send(publicRow(checked(result)));
  });

  app.get("/v1/organizations/:orgId/call-followups", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const org = uuid.parse((req.params as { orgId: string }).orgId);
    const query = z.object({ kind: z.enum(["ticket", "deal"]).optional(), cursor: z.string().max(500).optional() }).parse(req.query);
    await membership(req, org);
    let request = db(req).from("call_followups").select(selection).eq("organization_id", org).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(31);
    if (query.kind) request = request.eq("kind", query.kind);
    if (query.cursor) {
      let cursor: z.infer<typeof cursorSchema>;
      try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString())); }
      catch { return fail("Curseur invalide.", 400); }
      request = request.or(`created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`);
    }
    const rows = checked(await request) ?? [];
    const items = rows.slice(0, 30).map(publicRow), last = items.at(-1);
    return { items, nextCursor: rows.length > 30 && last ? Buffer.from(JSON.stringify({ at: last.created_at, id: last.id })).toString("base64url") : null };
  });

  app.patch("/v1/call-followups/:id", async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const { status } = z.object({ status: z.enum(["open", "closed", "won", "lost"]) }).strict().parse(req.body);
    const existing = checked(await db(req).from("call_followups").select("kind").eq("id", id).maybeSingle());
    if (!existing) return fail("Suivi introuvable.", 404);
    if (existing.kind === "ticket" ? !["open", "closed"].includes(status) : !["open", "won", "lost"].includes(status)) fail("Statut invalide pour ce suivi.", 400);
    const updated = checked(await db(req).from("call_followups").update({ status }).eq("id", id).select(selection).maybeSingle());
    if (!updated) fail("Suivi introuvable ou accès retiré.", 404);
    return publicRow(updated);
  });
}
