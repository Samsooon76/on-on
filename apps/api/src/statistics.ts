import type { FastifyInstance } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { uuidSchema, type AdminSnapshot, type Database, type StatisticsCall, type StatisticsSnapshot } from "@onoff/contracts";
import { centerStore, checked, problem } from "./call-center-store.js";
import { isActiveOrganizationAdmin } from "./repositories/access.js";

const windowSchema = z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }).strict();
const MAX_CALLS = 20_000;

/** Keyset pagination also handles PostgREST installations with smaller page caps. */
export async function readStatisticsPages<T extends { id: string }>(read: (after: string | null) => PromiseLike<{ data: T[] | null; error: { code?: string } | null }>, maximum = MAX_CALLS): Promise<T[]> {
  const rows: T[] = [];
  let after: string | null = null;
  for (;;) {
    const page: T[] = checked(await read(after)) ?? [];
    if (!page.length) return rows;
    rows.push(...page);
    if (rows.length > maximum) problem("Cette période contient trop de données. Réduisez la plage de dates.", 422);
    const next: string = page.at(-1)!.id;
    if (next === after) problem("Le chargement des statistiques est incomplet. Réessayez.", 503);
    after = next;
  }
}

type CallRow = Pick<Database["public"]["Tables"]["calls"]["Row"], "id" | "line_id" | "remote_number" | "created_at" | "direction" | "status" | "result_code" | "ended_at" | "duration_seconds" | "ivr_state">;
type Leg = { id: string; call_id: string; device_id: string | null; parent_call_sid: string | null; answered_at: string | null };
export function statisticsCall(row: CallRow, legs: Leg[], deviceUsers: Map<string, string>, voicemails: { duration: number }[]): StatisticsCall {
  const state = row.ivr_state && typeof row.ivr_state === "object" && !Array.isArray(row.ivr_state) ? row.ivr_state : null;
  // The inbound root is answered by the IVR itself. Only a child leg or an
  // explicit routing outcome proves that the caller reached an interlocutor.
  const connected = legs.some(leg => leg.parent_call_sid && leg.answered_at) || ["queue_bridged", "forward_completed"].includes(row.result_code ?? "");
  const users = legs.filter(leg => row.direction === "outbound" ? !leg.parent_call_sid : leg.parent_call_sid && leg.answered_at)
    .flatMap(leg => leg.device_id && deviceUsers.has(leg.device_id) ? [deviceUsers.get(leg.device_id)!] : []);
  return {
    id: row.id, lineId: row.line_id, remoteNumber: row.remote_number, createdAt: row.created_at,
    direction: row.direction === "outbound" ? "outbound" : "inbound", status: row.status, resultCode: row.result_code,
    connected, ended: !!row.ended_at || ["completed", "missed", "failed", "canceled"].includes(row.status),
    durationSeconds: connected ? row.duration_seconds : null, userIds: [...new Set(users)],
    routing: state?.engine === "taskrouter" ? "center" : state ? "ivr" : "direct",
    transfers: typeof state?.epoch === "number" ? Math.max(0, state.epoch) : 0,
    voicemailCount: voicemails.length, voicemailSeconds: voicemails.reduce((sum, message) => sum + message.duration, 0),
  };
}

export function registerStatisticsRoutes(app: FastifyInstance, service: SupabaseClient<Database> | null) {
  app.get<{ Params: { orgId: string } }>("/v1/organizations/:orgId/statistics", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!request.context) return reply.code(401).send({ code: "unauthorized", message: "Session requise." });
    if (!uuidSchema.safeParse(request.params.orgId).success) problem("Identifiant invalide.");
    const orgId = request.params.orgId;
    const access = await isActiveOrganizationAdmin(request.context.supabase, request.context.userId, orgId);
    if (access.unavailable) problem("Les autorisations sont indisponibles.", 503);
    if (!access.data) problem("Les statistiques sont réservées aux administrateurs actifs.", 403);
    if (!service) problem("Les statistiques sont indisponibles.", 503);
    const parsed = windowSchema.safeParse(request.query);
    if (!parsed.success) problem("Renseignez une période valide.");
    const { from, to } = parsed.data;
    const span = Date.parse(to) - Date.parse(from);
    if (span <= 0 || span > 186 * 86_400_000) problem("La période, comparaison comprise, est limitée à 186 jours.");
    const db = centerStore(service);
    // The RPC rechecks both active organization and active administrator.
    const admin = checked(await db.rpc("admin_snapshot", { p_org_id: orgId, p_actor_id: request.context.userId })) as unknown as AdminSnapshot;
    const fetchedAt = new Date().toISOString();
    const rows = await readStatisticsPages(after => {
      let query = db.from("calls").select("id,line_id,remote_number,created_at,direction,status,result_code,ended_at,duration_seconds,ivr_state")
        .eq("organization_id", orgId).gte("created_at", from).lt("created_at", to).lte("created_at", fetchedAt).order("id").limit(500);
      if (after) query = query.gt("id", after);
      return query;
    });
    const queues = await readStatisticsPages(after => {
      let query = db.from("voice_queues").select("id,config").eq("organization_id", orgId).order("id").limit(500);
      if (after) query = query.gt("id", after);
      return query;
    });
    const calls: StatisticsCall[] = [];
    for (let offset = 0; offset < rows.length; offset += 100) {
      const batch = rows.slice(offset, offset + 100), ids = batch.map(call => call.id);
      const [legs, voicemails] = await Promise.all([
        readStatisticsPages(after => {
          let query = db.from("call_legs").select("id,call_id,device_id,parent_call_sid,answered_at").eq("organization_id", orgId).in("call_id", ids).order("id").limit(500);
          if (after) query = query.gt("id", after);
          return query;
        }),
        readStatisticsPages(after => {
          let query = db.from("voice_voicemails").select("id,call_id,duration").eq("organization_id", orgId).in("call_id", ids).order("id").limit(500);
          if (after) query = query.gt("id", after);
          return query;
        }),
      ]);
      const deviceIds = [...new Set(legs.flatMap(leg => leg.device_id ? [leg.device_id] : []))];
      const deviceUsers = new Map<string, string>();
      for (let i = 0; i < deviceIds.length; i += 100) {
        const devices = await readStatisticsPages(after => {
          let query = db.from("devices").select("id,user_id").eq("organization_id", orgId).in("id", deviceIds.slice(i, i + 100)).order("id").limit(500);
          if (after) query = query.gt("id", after);
          return query;
        });
        for (const device of devices) deviceUsers.set(device.id, device.user_id);
      }
      for (const row of batch) calls.push(statisticsCall(row, legs.filter(leg => leg.call_id === row.id), deviceUsers, voicemails.filter(message => message.call_id === row.id)));
    }
    return {
      fetchedAt, from, to, calls,
      users: admin.members.map(member => ({ id: member.user_id, name: member.display_name })),
      lines: admin.lines.map(line => ({ id: line.id, number: line.phone_number })),
      teams: queues.map(queue => ({ id: queue.id, name: queue.config.name, userIds: queue.config.memberIds })),
    } satisfies StatisticsSnapshot;
  });
}
