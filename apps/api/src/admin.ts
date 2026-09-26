import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminMemberCreateSchema, adminMemberUpdateSchema, adminIvrUpdateSchema, uuidSchema, type Database } from "@onoff/contracts";
import { isActiveOrganizationAdmin } from "./repositories/access.js";

function fail(reply: FastifyReply, request: FastifyRequest, status: number, code: string, message: string) {
  return reply.code(status).send({ code, message, requestId: request.id });
}

function databaseFailure(reply: FastifyReply, request: FastifyRequest, code: string) {
  if (code === "42501") return fail(reply, request, 403, "admin_forbidden", "Un administrateur actif est requis.");
  if (code === "40001") return fail(reply, request, 409, "admin_conflict", "Ces données ont changé. Actualisez avant de réessayer.");
  if (code === "23514") return fail(reply, request, 409, "last_admin", "Conservez au moins un administrateur actif dans l’organisation.");
  if (code === "23503") return fail(reply, request, 400, "invalid_ivr_target", "Chaque destinataire du menu doit être actif et disposer du droit Appels sur cette ligne.");
  if (code === "22023") return fail(reply, request, 400, "invalid_admin_data", "Vérifiez les champs et les capacités de la ligne.");
  if (code === "P0002") return fail(reply, request, 404, "not_found", "Élément introuvable dans cette organisation.");
  return fail(reply, request, 503, "admin_unavailable", "L’administration est momentanément indisponible.");
}

export function registerAdminRoutes(app: FastifyInstance, service: SupabaseClient<Database> | null) {
  const base = "/v1/organizations/:orgId/admin";
  type Params = { orgId: string; userId?: string; lineId?: string };
  async function authorize(request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) {
    const context = request.context;
    if (!context) { fail(reply, request, 401, "unauthorized", "Session requise."); return null; }
    if (!uuidSchema.safeParse(request.params.orgId).success
      || (request.params.userId !== undefined && !uuidSchema.safeParse(request.params.userId).success)
      || (request.params.lineId !== undefined && !uuidSchema.safeParse(request.params.lineId).success)) {
      fail(reply, request, 400, "invalid_request", "Identifiant invalide."); return null;
    }
    const admin = await isActiveOrganizationAdmin(context.supabase, context.userId, request.params.orgId);
    if (admin.unavailable) { fail(reply, request, 503, "admin_unavailable", "Les autorisations ne sont pas disponibles."); return null; }
    if (!admin.data) { fail(reply, request, 403, "admin_forbidden", "Cet espace est réservé aux administrateurs."); return null; }
    if (!service) { fail(reply, request, 503, "admin_unavailable", "L’administration n’est pas configurée."); return null; }
    return { service, actorId: context.userId, orgId: request.params.orgId };
  }
  app.get<{ Params: Params }>(base, async (request, reply) => {
    const scope = await authorize(request, reply); if (!scope) return;
    const { data, error } = await scope.service.rpc("admin_snapshot", { p_org_id: scope.orgId, p_actor_id: scope.actorId });
    if (error) return databaseFailure(reply, request, error.code);
    reply.header("cache-control", "no-store");
    return data;
  });
  app.post<{ Params: Params }>(`${base}/members`, async (request, reply) => {
    const scope = await authorize(request, reply); if (!scope) return;
    const parsed = adminMemberCreateSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "invalid_member", "Renseignez un nom, un email valide et un mot de passe de 12 caractères minimum.");
    const input = parsed.data;
    // Never log the body or return the password. Existing accounts are never overwritten.
    const { data: created, error: authError } = await scope.service.auth.admin.createUser({ email: input.email, password: input.password, email_confirm: true });
    if (authError || !created.user) {
      const exists = authError?.code === "email_exists" || authError?.code === "user_already_exists";
      return fail(reply, request, exists ? 409 : 400, exists ? "email_exists" : "user_not_created", exists ? "Un compte utilise déjà cet email. Aucun compte n’a été modifié." : "Le compte n’a pas pu être créé. Vérifiez l’email et la robustesse du mot de passe.");
    }
    const { error } = await scope.service.rpc("admin_create_member", { p_org_id: scope.orgId, p_actor_id: scope.actorId, p_user_id: created.user.id, p_display_name: input.displayName, p_role: input.role });
    if (error) {
      // Only compensate after proving no membership was committed (network errors are ambiguous).
      const check = await scope.service.from("memberships").select("user_id, organization_id").eq("user_id", created.user.id).limit(1);
      if (!check.error && check.data?.length === 0) {
        const cleanup = await scope.service.auth.admin.deleteUser(created.user.id);
        if (cleanup.error) request.log.error({ userId: created.user.id, code: cleanup.error.code }, "unattached admin-created account needs cleanup");
      } else if (!check.error && check.data?.some((row) => row.user_id === created.user.id && row.organization_id === scope.orgId)) {
        return reply.code(201).send({ id: created.user.id });
      }
      return databaseFailure(reply, request, error.code);
    }
    return reply.code(201).send({ id: created.user.id });
  });
  app.patch<{ Params: Params }>(`${base}/members/:userId`, async (request, reply) => {
    const scope = await authorize(request, reply); if (!scope) return;
    const parsed = adminMemberUpdateSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "invalid_member", "Les données du membre sont invalides.");
    const { data, error } = await scope.service.rpc("admin_update_member", { p_org_id: scope.orgId, p_actor_id: scope.actorId, p_user_id: request.params.userId!, p_display_name: parsed.data.displayName, p_role: parsed.data.role, p_status: parsed.data.status, p_version: parsed.data.version });
    if (error) return databaseFailure(reply, request, error.code);
    return { id: data };
  });
  app.put<{ Params: Params }>(`${base}/lines/:lineId/ivr`, async (request, reply) => {
    const scope = await authorize(request, reply); if (!scope) return;
    const parsed = adminIvrUpdateSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, request, 400, "invalid_ivr", "Vérifiez le message, les touches uniques et les destinataires du menu.");
    const { data, error } = await scope.service.rpc("admin_set_ivr", { p_org_id: scope.orgId, p_actor_id: scope.actorId, p_line_id: request.params.lineId!, p_config: parsed.data.config, p_version: parsed.data.version });
    if (error) return databaseFailure(reply, request, error.code);
    return { id: data };
  });
}
