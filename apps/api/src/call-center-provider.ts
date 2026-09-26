import twilio from "twilio";
import type { AppConfig } from "./config.js";
import { checked, problem, type CenterStore, type WorkspaceRow, type QueueRow } from "./call-center-store.js";

export type CenterProvider = ReturnType<typeof twilio>;
export function createCenterProvider(config: AppConfig): CenterProvider | null {
  return config.TWILIO_ACCOUNT_SID && config.TWILIO_API_KEY_SID && config.TWILIO_API_KEY_SECRET
    ? twilio(config.TWILIO_API_KEY_SID, config.TWILIO_API_KEY_SECRET, { accountSid: config.TWILIO_ACCOUNT_SID, timeout: 4000, autoRetry: false }) : null;
}
export function allowedNumber(number: string, config: AppConfig) {
  if (!config.TWILIO_ALLOWED_DESTINATIONS.split(",").map(v => v.trim()).filter(Boolean).some(prefix => number.startsWith(prefix))) problem("Ce pays n’est pas autorisé pour les renvois d’appels.");
}
export async function ensureWorkspace(db: CenterStore, provider: CenterProvider, orgId: string, base: string): Promise<WorkspaceRow> {
  const saved = checked(await db.from("voice_workspaces").select("*").eq("organization_id", orgId).single());
  if (!saved) problem("Initialisez le centre d’appels.", 409);
  let sid = saved.workspace_sid;
  if (!sid) {
    const name = `onoff_${orgId}`;
    const existing = (await provider.taskrouter.v1.workspaces.list({ limit: 1000 })).find(w => w.friendlyName === name);
    sid = existing?.sid ?? (await provider.taskrouter.v1.workspaces.create({ friendlyName: name, eventCallbackUrl: `${base}/webhooks/twilio/center/events`, multiTaskEnabled: false })).sid;
    checked(await db.from("voice_workspaces").update({ workspace_sid: sid }).eq("organization_id", orgId));
  }
  const workspace = provider.taskrouter.v1.workspaces(sid);
  const activities: Record<string, string> = {};
  const existing = await workspace.activities.list({ limit: 100 });
  for (const [key, name, available] of [["available", "Disponible", true], ["offline", "Hors ligne", false], ["break", "En pause", false], ["reserved", "Sonnerie", false], ["busy", "En appel", false]] as const) {
    activities[key] = existing.find(a => a.friendlyName === name && a.available === available)?.sid ?? (await workspace.activities.create({ friendlyName: name, available })).sid;
  }
  await workspace.update({ defaultActivitySid: activities.offline!, timeoutActivitySid: activities.offline!, eventCallbackUrl: `${base}/webhooks/twilio/center/events` });
  checked(await db.from("voice_workspaces").update({ activities }).eq("organization_id", orgId));
  return { ...saved, workspace_sid: sid, activities };
}
export async function provisionQueue(db: CenterStore, provider: CenterProvider, workspace: WorkspaceRow, queue: QueueRow, base: string) {
  const remote = provider.taskrouter.v1.workspaces(workspace.workspace_sid!);
  const existingAgents = checked(await db.from("voice_agents").select("*").eq("organization_id", queue.organization_id));
  // Stable names let a retry recover resources created before a network/DB failure.
  const workers = await remote.workers.list({ limit: 5000 });
  for (const userId of queue.config.memberIds) {
    if (existingAgents.some(a => a.user_id === userId)) continue;
    const name = `agent_${userId}`;
    const worker = workers.find(w => w.friendlyName === name) ?? await remote.workers.create({ friendlyName: name, activitySid: workspace.activities.offline!, attributes: JSON.stringify({ user_id: userId }) });
    checked(await db.from("voice_agents").upsert({ organization_id: queue.organization_id, user_id: userId, worker_sid: worker.sid, contact_number: null }, { onConflict: "organization_id,user_id", ignoreDuplicates: true }));
  }
  const queueName = `queue_${queue.id}`;
  const targetWorkers = `user_id IN ${JSON.stringify(queue.config.memberIds)}`;
  let queueSid = queue.queue_sid;
  if (!queueSid) queueSid = (await remote.taskQueues.list({ friendlyName: queueName, limit: 250 }))[0]?.sid ?? (await remote.taskQueues.create({ friendlyName: queueName, targetWorkers, reservationActivitySid: workspace.activities.reserved!, assignmentActivitySid: workspace.activities.busy!, maxReservedWorkers: 1 })).sid;
  await remote.taskQueues(queueSid).update({ targetWorkers, reservationActivitySid: workspace.activities.reserved!, assignmentActivitySid: workspace.activities.busy!, maxReservedWorkers: 1 });
  checked(await db.from("voice_queues").update({ queue_sid: queueSid }).eq("organization_id", queue.organization_id).eq("id", queue.id));
  const workflowName = `flow_${queue.id}`;
  const workflowOptions = { friendlyName: workflowName, taskReservationTimeout: queue.config.ringTimeout + 10, assignmentCallbackUrl: `${base}/webhooks/twilio/center/assignment`, configuration: JSON.stringify({ task_routing: { filters: [], default_filter: { queue: queueSid } } }) };
  let workflowSid = queue.workflow_sid;
  if (!workflowSid) workflowSid = (await remote.workflows.list({ friendlyName: workflowName, limit: 250 }))[0]?.sid ?? (await remote.workflows.create(workflowOptions)).sid;
  await remote.workflows(workflowSid).update(workflowOptions);
  checked(await db.from("voice_queues").update({ workflow_sid: workflowSid, synced_version: queue.version }).eq("organization_id", queue.organization_id).eq("id", queue.id));
}
