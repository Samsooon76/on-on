import { z } from "zod";

const id = z.string().uuid();
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/, "Utilisez le format international, par exemple +33123456789.");
const audio = z.url().refine(value => value.startsWith("https://"), "L’audio doit être accessible en HTTPS.").nullable();
export const destinationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("queue"), queueId: id }).strict(),
  z.object({ type: z.literal("number"), number: phone }).strict(),
  z.object({ type: z.literal("menu"), menuId: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/) }).strict(),
  z.object({ type: z.literal("voicemail") }).strict(),
  z.object({ type: z.literal("hangup") }).strict(),
]);
export type VoiceDestination = z.infer<typeof destinationSchema>;
export const queueConfigSchema = z.object({
  name: z.string().trim().min(1).max(80),
  memberIds: z.array(id).min(1, "Ajoutez au moins un agent.").max(50).refine(v => new Set(v).size === v.length),
  maxWaitSeconds: z.number().int().min(15).max(3600),
  ringTimeout: z.number().int().min(5).max(60),
  holdMessage: z.string().trim().min(1).max(1000),
  holdMusicUrl: audio,
  announcePosition: z.boolean(),
  overflow: z.union([z.object({ type: z.literal("number"), number: phone }).strict(), z.object({ type: z.literal("voicemail") }).strict(), z.object({ type: z.literal("hangup") }).strict()]),
}).strict();
export type QueueConfig = z.infer<typeof queueConfigSchema>;
export const voiceFlowSchema = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  language: z.enum(["fr-FR", "en-GB", "en-US"]),
  greeting: z.string().trim().max(1000),
  greetingAudioUrl: audio,
  entry: destinationSchema,
  menus: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    name: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(1000),
    timeout: z.number().int().min(3).max(15),
    maxAttempts: z.number().int().min(1).max(3),
    options: z.array(z.object({ digit: z.string().regex(/^[0-9]$/), label: z.string().trim().min(1).max(80), destination: destinationSchema }).strict()).min(1).max(10),
    fallback: destinationSchema,
  }).strict()).max(12),
  schedule: z.object({
    enabled: z.boolean(),
    timezone: z.string().max(80).refine(value => { try { new Intl.DateTimeFormat("fr", { timeZone: value }); return true; } catch { return false; } }, "Fuseau horaire invalide."),
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    opensAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    closesAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    closed: destinationSchema,
  }).strict(),
  ringTimeout: z.number().int().min(5).max(60),
  voicemailGreeting: z.string().trim().min(1).max(1000),
  maxRecordingSeconds: z.number().int().min(10).max(300),
  noAnswer: z.enum(["voicemail", "hangup"]),
}).strict().superRefine((flow, ctx) => {
  const menuIds = new Set(flow.menus.map(menu => menu.id));
  if (menuIds.size !== flow.menus.length) ctx.addIssue({ code: "custom", message: "Les identifiants des menus doivent être uniques." });
  for (const menu of flow.menus) if (new Set(menu.options.map(o => o.digit)).size !== menu.options.length) ctx.addIssue({ code: "custom", message: `Une touche est utilisée deux fois dans ${menu.name}.` });
  for (const target of flowDestinations(flow)) if (target.type === "menu" && !menuIds.has(target.menuId)) ctx.addIssue({ code: "custom", message: "Un menu de destination n’existe plus." });
  if (flow.schedule.enabled && flow.schedule.opensAt === flow.schedule.closesAt) ctx.addIssue({ code: "custom", message: "Les horaires d’ouverture et de fermeture doivent être différents." });
});
export type VoiceFlow = z.infer<typeof voiceFlowSchema>;
export function flowDestinations(flow: { entry: VoiceDestination; schedule: { closed: VoiceDestination }; menus: { fallback: VoiceDestination; options: { destination: VoiceDestination }[] }[] }): VoiceDestination[] {
  return [flow.entry, flow.schedule.closed, ...flow.menus.flatMap(menu => [menu.fallback, ...menu.options.map(option => option.destination)])];
}
export function defaultVoiceFlow(): VoiceFlow {
  return { name: "Accueil téléphonique", enabled: true, language: "fr-FR", greeting: "Bienvenue.", greetingAudioUrl: null, entry: { type: "menu", menuId: "accueil" }, menus: [{ id: "accueil", name: "Menu principal", prompt: "Comment pouvons-nous vous aider ?", timeout: 5, maxAttempts: 2, options: [{ digit: "1", label: "laisser un message", destination: { type: "voicemail" } }], fallback: { type: "voicemail" } }], schedule: { enabled: false, timezone: "Europe/Paris", days: [1, 2, 3, 4, 5], opensAt: "09:00", closesAt: "18:00", closed: { type: "voicemail" } }, ringTimeout: 25, voicemailGreeting: "Laissez votre message après le signal sonore. Il sera enregistré pour notre équipe.", maxRecordingSeconds: 120, noAnswer: "voicemail" };
}
export const agentUpdateSchema = z.object({ activity: z.enum(["available", "offline", "break"]), contactNumber: phone.nullable() }).strict();
export type VoiceQueue = { id: string; line_id: string; config: QueueConfig; version: number; provisioned: boolean };
export type VoiceFlowRecord = { line_id: string; draft: VoiceFlow; published: VoiceFlow | null; version: number; published_at: string | null };
export type CenterAgent = { userId: string; name: string; workerSid: string | null; contactNumber: string | null; activity: string; available: boolean; reachable: boolean; queueIds: string[] };
export type CenterTask = { sid: string; callSid: string; callId: string; queueId: string; caller: string; status: string; age: number; workerName: string | null; priority: number };
export type CenterSnapshot = {
  configured: boolean; provisioned: boolean; live: boolean; liveError: string | null; fetchedAt: string;
  queues: VoiceQueue[]; flows: VoiceFlowRecord[]; agents: CenterAgent[]; tasks: CenterTask[];
  statistics: { queueId: string; waiting: number; reserved: number; assigned: number; available: number; longestWait: number }[];
  voicemails: { id: string; call_id: string; caller: string; duration: number; created_at: string }[];
};
