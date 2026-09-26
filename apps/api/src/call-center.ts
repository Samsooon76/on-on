import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { agentUpdateSchema, destinationSchema, flowDestinations, queueConfigSchema, uuidSchema, voiceFlowSchema, type AdminSnapshot, type CenterSnapshot, type Database, type VoiceFlow, type VoiceDestination } from "@onoff/contracts";
import type { AppConfig } from "./config.js";
import { centerStore, checked, problem, type WorkspaceRow } from "./call-center-store.js";
import { allowedNumber, ensureWorkspace, provisionQueue, type CenterProvider } from "./call-center-provider.js";
import { voiceCenterRuntime, isOpen, type VoiceSession } from "./call-center-voice.js";
import { isActiveOrganizationAdmin } from "./repositories/access.js";

export function registerCallCenter(app: FastifyInstance, service: SupabaseClient<Database> | null, provider: CenterProvider | null, config: AppConfig, validate: (request: FastifyRequest) => boolean) {
  if (!service) {
    app.get("/v1/organizations/:orgId/center", async (_request,reply) => reply.code(503).send({ code:"center_unavailable",message:"La clé serveur Supabase n’est pas configurée." }));
    return { inbound: async (_routing: unknown, _body: Record<string,string>) => null as string | null };
  }
  const db = centerStore(service), runtime = voiceCenterRuntime(db,provider,config), base = config.API_PUBLIC_URL.replace(/\/$/,"");
  const root = "/v1/organizations/:orgId/center";
  type Params = { orgId: string; id?: string };
  async function scope(request: FastifyRequest<{ Params:Params }>, reply: FastifyReply, admin = true) {
    if (!request.context) { reply.code(401).send({ code:"unauthorized", message:"Session requise." }); return null; }
    if (!uuidSchema.safeParse(request.params.orgId).success || (request.params.id && !uuidSchema.safeParse(request.params.id).success)) problem("Identifiant invalide.");
    if (admin) {
      const access = await isActiveOrganizationAdmin(request.context.supabase,request.context.userId,request.params.orgId);
      if (access.unavailable) problem("Les autorisations sont indisponibles.",503);
      if (!access.data) problem("Un administrateur actif est requis.",403);
    } else {
      const member = checked(await db.from("memberships").select("user_id").eq("organization_id",request.params.orgId).eq("user_id",request.context.userId).eq("status","active").maybeSingle());
      if (!member) problem("Accès à l’espace refusé.",403);
    }
    const organization = checked(await db.from("organizations").select("id").eq("id",request.params.orgId).eq("status","active").maybeSingle());
    if (!organization) problem("Cet espace est inactif.",403);
    reply.header("cache-control","no-store");
    return { orgId:request.params.orgId, actorId:request.context.userId };
  }
  function requireProvider() {
    if (!provider || !config.VOICE_ENABLED) problem("La voix Twilio doit être activée et configurée sur le serveur.",503);
    if (config.OPERATIONS_PAUSED) problem(config.OPERATIONS_PAUSE_MESSAGE,503);
    if (!base.startsWith("https://")) problem("Une URL publique HTTPS est requise pour les appels Twilio.",503);
    return provider;
  }
  async function locked<T>(orgId: string, actorId: string, work: () => Promise<T>) {
    const token = randomUUID();
    if (!checked(await db.rpc("voice_center_lock",{ p_org_id:orgId,p_actor_id:actorId,p_token:token }))) problem("Une configuration est déjà en cours. Réessayez dans quelques instants.",409);
    try { return await work(); } finally { await db.rpc("voice_center_lock",{ p_org_id:orgId,p_actor_id:actorId,p_token:token,p_release:true }); }
  }
  async function workspace(orgId: string) {
    const value = checked(await db.from("voice_workspaces").select("*").eq("organization_id",orgId).maybeSingle());
    if (!value?.workspace_sid) problem("Initialisez Twilio avec le bouton Activer le centre d’appels.",409);
    return value;
  }
  async function audit(orgId:string,actorId:string,action:string,targetId:string) {
    checked(await db.from("audit_events").insert({ organization_id:orgId,actor_user_id:actorId,action,target_type:"voice_center",target_id:targetId,outcome:"allowed" }));
  }
  async function validateTarget(orgId:string,lineId:string,target:VoiceDestination) {
    if (target.type === "number") {
      allowedNumber(target.number,config);
      const ownLine = checked(await db.from("lines").select("id").eq("phone_number",target.number).eq("twilio_account_sid",config.TWILIO_ACCOUNT_SID ?? "").eq("status","active").maybeSingle());
      if (ownLine) problem("Le renvoi vers une ligne de cette application créerait une boucle. Choisissez une file ou un numéro externe.");
    }
    if (target.type === "queue") {
      const queue = checked(await db.from("voice_queues").select("id,workflow_sid,synced_version,version").eq("organization_id",orgId).eq("line_id",lineId).eq("id",target.queueId).maybeSingle());
      if (!queue?.workflow_sid || queue.synced_version !== queue.version) problem("La file doit être active et rattachée à ce numéro.");
    }
  }
  app.post<{ Params:Params }>(`${root}/setup`,async(request,reply) => {
    const auth = await scope(request,reply); if (!auth) return;
    const remote = requireProvider();
    await locked(auth.orgId,auth.actorId,() => ensureWorkspace(db,remote,auth.orgId,base));
    await audit(auth.orgId,auth.actorId,"voice_center.setup",auth.orgId);
    return { configured:true };
  });
  app.put<{ Params:Params }>(`${root}/queues/:id`,async(request,reply) => {
    const auth = await scope(request,reply); if (!auth) return;
    const input = z.object({ lineId:uuidSchema,version:z.number().int().min(0),config:queueConfigSchema }).strict().parse(request.body);
    const remote = requireProvider();
    return locked(auth.orgId,auth.actorId,async() => {
      const line = checked(await db.from("lines").select("id").eq("organization_id",auth.orgId).eq("id",input.lineId).eq("status","active").eq("voice_enabled",true).maybeSingle());
      if (!line) problem("Numéro vocal introuvable.",404);
      const assignments = checked(await db.from("line_assignments").select("user_id").eq("organization_id",auth.orgId).eq("line_id",input.lineId).eq("status","active").eq("can_voice",true));
      const members = checked(await db.from("memberships").select("user_id").eq("organization_id",auth.orgId).eq("status","active"));
      if (input.config.memberIds.some(id => !assignments.some(a => a.user_id === id) || !members.some(m => m.user_id === id))) problem("Chaque agent doit être actif et avoir le droit Appels sur ce numéro.");
      await validateTarget(auth.orgId,input.lineId,input.config.overflow);
      const existing = checked(await db.from("voice_queues").select("*").eq("organization_id",auth.orgId).eq("id",request.params.id!).maybeSingle());
      if ((existing?.version ?? 0) !== input.version) problem("La file a changé. Actualisez avant de réessayer.",409);
      if (existing && existing.line_id !== input.lineId) problem("Une file ne peut pas changer de numéro.");
      const row = { id:request.params.id!,organization_id:auth.orgId,line_id:input.lineId,config:input.config,version:input.version+1,synced_version:existing?.synced_version??0,queue_sid:existing?.queue_sid ?? null,workflow_sid:existing?.workflow_sid ?? null,updated_at:new Date().toISOString() };
      if(existing) checked(await db.from("voice_queues").update(row).eq("organization_id",auth.orgId).eq("id",row.id).eq("version",input.version).select("id").single());
      else checked(await db.from("voice_queues").insert(row));
      // The database keeps the desired config on a provider failure; Save retries reconcile it.
      const ws = await ensureWorkspace(db,remote,auth.orgId,base);
      await provisionQueue(db,remote,ws,row,base);
      await audit(auth.orgId,auth.actorId,"voice_queue.save",row.id);
      return { id:row.id,version:row.version };
    });
  });
  app.delete<{ Params:Params }>(`${root}/queues/:id`,async(request,reply) => {
    const auth=await scope(request,reply); if(!auth)return;
    const remote=requireProvider();
    return locked(auth.orgId,auth.actorId,async() => {
      const queue=checked(await db.from("voice_queues").select("*").eq("organization_id",auth.orgId).eq("id",request.params.id!).maybeSingle());
      if(!queue)problem("File introuvable.",404);
      const flows=checked(await db.from("voice_flows").select("draft,published").eq("organization_id",auth.orgId));
      if(flows.some(f=>[f.draft,f.published].some(flow=>flow && flowDestinations(flow).some(d=>d.type==="queue" && d.queueId===queue.id))))problem("Retirez cette file des menus publiés et des brouillons avant de la supprimer.",409);
      const ws=await workspace(auth.orgId), w=remote.taskrouter.v1.workspaces(ws.workspace_sid!);
      if(queue.queue_sid){const stats=await w.taskQueues(queue.queue_sid).realTimeStatistics().fetch();if(stats.totalTasks>0)problem("La file contient encore des appels.",409);}
      async function remove(work:()=>Promise<unknown>){try{await work();}catch(e){if((e as {status?:number}).status!==404)throw e;}}
      if(queue.workflow_sid)await remove(()=>w.workflows(queue.workflow_sid!).remove());
      if(queue.queue_sid)await remove(()=>w.taskQueues(queue.queue_sid!).remove());
      checked(await db.from("voice_queues").delete().eq("organization_id",auth.orgId).eq("id",queue.id));
      await audit(auth.orgId,auth.actorId,"voice_queue.delete",queue.id);
      return { id:queue.id };
    });
  });
  app.put<{ Params:Params }>(`${root}/flows/:id`,async(request,reply) => {
    const auth=await scope(request,reply);if(!auth)return;
    const input=z.object({config:voiceFlowSchema,version:z.number().int().min(0),publish:z.boolean()}).strict().parse(request.body);
    if(input.publish)requireProvider();
    return locked(auth.orgId,auth.actorId,async()=>{
      for(const target of flowDestinations(input.config))await validateTarget(auth.orgId,request.params.id!,target);
      if(input.publish){
        const line=checked(await db.from("lines").select("twilio_phone_number_sid,twilio_account_sid").eq("organization_id",auth.orgId).eq("id",request.params.id!).single());
        if(!line || line.twilio_account_sid!==config.TWILIO_ACCOUNT_SID || !line.twilio_phone_number_sid)problem("Ce numéro n’est pas relié au compte Twilio configuré.");
        // Validate before publishing, without silently changing unrelated number settings.
        const number=await provider!.incomingPhoneNumbers(line.twilio_phone_number_sid).fetch();
        if(number.voiceUrl!==`${base}/webhooks/twilio/voice/inbound` || number.voiceMethod!=="POST")problem("Le webhook du numéro doit pointer vers l’API entrante. Utilisez Connecter le numéro.",409);
      }
      const version=checked(await db.rpc("voice_flow_save",{p_org_id:auth.orgId,p_actor_id:auth.actorId,p_line_id:request.params.id!,p_config:input.config,p_version:input.version,p_publish:input.publish}));
      return {version};
    });
  });
  app.post<{ Params:Params }>(`${root}/lines/:id/connect`,async(request,reply)=>{
    const auth=await scope(request,reply);if(!auth)return;
    const remote=requireProvider();
    const line=checked(await db.from("lines").select("twilio_phone_number_sid,twilio_account_sid").eq("organization_id",auth.orgId).eq("id",request.params.id!).eq("status","active").eq("voice_enabled",true).single());
    if(!line || line.twilio_account_sid!==config.TWILIO_ACCOUNT_SID || !line.twilio_phone_number_sid)problem("Numéro non disponible sur ce compte Twilio.");
    await remote.incomingPhoneNumbers(line.twilio_phone_number_sid).update({voiceUrl:`${base}/webhooks/twilio/voice/inbound`,voiceMethod:"POST",statusCallback:`${base}/webhooks/twilio/voice/status`,statusCallbackMethod:"POST"});
    await audit(auth.orgId,auth.actorId,"voice_line.connect",request.params.id!);
    return {connected:true};
  });
  async function updateAgent(orgId:string,userId:string,input:z.infer<typeof agentUpdateSchema>,allowContact:boolean){
    const remote=requireProvider(),ws=await workspace(orgId);
    const agent=checked(await db.from("voice_agents").select("*").eq("organization_id",orgId).eq("user_id",userId).maybeSingle());
    if(!agent)problem("Ajoutez d’abord cet agent à une file.",404);
    if(!allowContact && input.contactNumber!==agent.contact_number)problem("Seul un administrateur peut modifier le numéro de réception.",403);
    if(input.contactNumber)await validateTarget(orgId,"",{type:"number",number:input.contactNumber});
    const member=checked(await db.from("memberships").select("user_id").eq("organization_id",orgId).eq("user_id",userId).eq("status","active").maybeSingle());
    if(!member)problem("Cet utilisateur n’est plus actif.",403);
    const worker=remote.taskrouter.v1.workspaces(ws.workspace_sid!).workers(agent.worker_sid);
    const live=await worker.fetch();
    if([ws.activities.busy,ws.activities.reserved].includes(live.activitySid))problem("Terminez l’appel ou la sonnerie avant de changer de statut.",409);
    if(input.activity==="available" && !input.contactNumber){
      const devices=checked(await db.from("devices").select("platform,voice_registered_at").eq("organization_id",orgId).eq("user_id",userId).eq("status","active").not("voice_registered_at","is",null));
      if(!devices.some(d=>["ios","android"].includes(d.platform)||Date.parse(d.voice_registered_at!)>Date.now()-90000))problem("L’agent doit activer la réception dans son application ou disposer d’un numéro externe.",409);
    }
    checked(await db.from("voice_agents").update({contact_number:input.contactNumber}).eq("organization_id",orgId).eq("user_id",userId));
    await worker.update({activitySid:ws.activities[input.activity]!});
    return {updated:true};
  }
  app.put<{Params:Params}>(`${root}/agents/:id`,async(request,reply)=>{const auth=await scope(request,reply);if(!auth)return;return updateAgent(auth.orgId,request.params.id!,agentUpdateSchema.parse(request.body),true);});
  app.put<{Params:Params}>(`${root}/presence`,async(request,reply)=>{const auth=await scope(request,reply,false);if(!auth)return;return updateAgent(auth.orgId,auth.actorId,agentUpdateSchema.parse(request.body),false);});
  app.get<{Params:Params}>(`${root}/presence`,async(request,reply)=>{
    const auth=await scope(request,reply,false);if(!auth)return;
    const agent=checked(await db.from("voice_agents").select("*").eq("organization_id",auth.orgId).eq("user_id",auth.actorId).maybeSingle());
    if(!agent)return {enrolled:false};
    const ws=await workspace(auth.orgId),remote=requireProvider();
    const worker=await remote.taskrouter.v1.workspaces(ws.workspace_sid!).workers(agent.worker_sid).fetch();
    return {enrolled:true,activity:worker.activityName,available:worker.available,contactNumber:agent.contact_number};
  });
  app.get<{Params:Params}>(root,async(request,reply)=>{
    const auth=await scope(request,reply);if(!auth)return;
    const [wsResult,queueResult,agentResult,flowResult,adminResult,deviceResult,voicemailResult]=await Promise.all([
      db.from("voice_workspaces").select("*").eq("organization_id",auth.orgId).maybeSingle(),db.from("voice_queues").select("*").eq("organization_id",auth.orgId).order("updated_at"),db.from("voice_agents").select("*").eq("organization_id",auth.orgId),db.from("voice_flows").select("*").eq("organization_id",auth.orgId),db.rpc("admin_snapshot",{p_org_id:auth.orgId,p_actor_id:auth.actorId}),db.from("devices").select("user_id,platform,voice_registered_at").eq("organization_id",auth.orgId).eq("status","active").not("voice_registered_at","is",null),db.from("voice_voicemails").select("*").eq("organization_id",auth.orgId).order("created_at",{ascending:false}).limit(50),
    ]);
    const ws=checked(wsResult),queues=checked(queueResult),agents=checked(agentResult),flows=checked(flowResult),admin=checked(adminResult) as unknown as AdminSnapshot,devices=checked(deviceResult),voicemails=checked(voicemailResult);
    const result:CenterSnapshot={configured:!!provider && config.VOICE_ENABLED,provisioned:!!ws?.workspace_sid,live:false,liveError:null,fetchedAt:new Date().toISOString(),queues:queues.map(q=>({id:q.id,line_id:q.line_id,config:q.config,version:q.version,provisioned:!!q.workflow_sid&&q.synced_version===q.version})),flows,agents:[],tasks:[],statistics:[],voicemails:[]};
    result.agents=agents.map(a=>({userId:a.user_id,name:admin.members.find(m=>m.user_id===a.user_id)?.display_name??"Utilisateur",workerSid:a.worker_sid,contactNumber:a.contact_number,activity:"Indisponible",available:false,reachable:!!a.contact_number||devices.some(d=>d.user_id===a.user_id&&(["ios","android"].includes(d.platform)||Date.parse(d.voice_registered_at!)>Date.now()-90000)),queueIds:queues.filter(q=>q.config.memberIds.includes(a.user_id)).map(q=>q.id)}));
    if(voicemails.length){const calls=checked(await db.from("calls").select("id,remote_number").eq("organization_id",auth.orgId).in("id",voicemails.map(v=>v.call_id)));result.voicemails=voicemails.map(v=>({id:v.id,call_id:v.call_id,caller:calls.find(c=>c.id===v.call_id)?.remote_number??"",duration:v.duration,created_at:v.created_at}));}
    if(provider && config.VOICE_ENABLED && ws?.workspace_sid){
      try{
        const remote=provider.taskrouter.v1.workspaces(ws.workspace_sid);
        const [workers,tasks,stats]=await Promise.all([remote.workers.list({limit:5000}),Promise.all((["pending","reserved","assigned","wrapping"] as const).map(assignmentStatus=>remote.tasks.list({assignmentStatus:[assignmentStatus],limit:1000}))).then(values=>values.flat()),Promise.all(queues.filter(q=>q.queue_sid).map(async q=>({queueId:q.id,data:await remote.taskQueues(q.queue_sid!).realTimeStatistics().fetch()})))]);
        result.agents=result.agents.map(a=>{const worker=workers.find(w=>w.sid===a.workerSid);return {...a,activity:worker?.activityName??"Inconnu",available:worker?.available??false};});
        result.tasks=tasks.flatMap(task=>{let attrs:Record<string,unknown>;try{attrs=JSON.parse(task.attributes);}catch{return[];}const queue=queues.find(q=>q.id===attrs.queue_id);if(!queue || attrs.organization_id!==auth.orgId)return[];return[{sid:task.sid,callSid:String(attrs.call_sid??""),callId:String(attrs.call_id??""),queueId:queue.id,caller:String(attrs.from??""),status:task.assignmentStatus,age:task.age,workerName:result.agents.find(a=>a.workerSid===attrs.worker_sid)?.name??null,priority:task.priority}];});
        result.statistics=stats.map(({queueId,data})=>({queueId,waiting:Number(data.tasksByStatus.pending??0),reserved:Number(data.tasksByStatus.reserved??0),assigned:Number(data.tasksByStatus.assigned??0),available:data.totalAvailableWorkers,longestWait:data.longestTaskWaitingAge}));
        const activeTasks = result.tasks.filter(t => ["reserved","assigned","wrapping"].includes(t.status));
        await Promise.all(activeTasks.map(async task => {
          const reservations = await remote.tasks(task.sid).reservations.list({limit:100});
          const assigned = reservations.find(r => ["pending","accepted","wrapping"].includes(r.reservationStatus));
          task.workerName = result.agents.find(a => a.workerSid === assigned?.workerSid)?.name ?? null;
        }));
        result.live=true;
      }catch(error){request.log.warn({code:(error as {code?:number}).code},"TaskRouter live read failed");result.statistics=[];result.tasks=[];result.liveError="Twilio ne répond pas. Les statuts et compteurs en direct sont indisponibles.";}
    }
    return result;
  });
  app.post<{Params:Params}>(`${root}/tasks/transfer`,async(request,reply)=>{
    const auth=await scope(request,reply);if(!auth)return;
    const input=z.object({taskSid:z.string().regex(/^WT[0-9a-fA-F]{32}$/),operationId:uuidSchema,destination:destinationSchema.refine(d=>d.type!=="menu")}).strict().parse(request.body);
    const remote=requireProvider(),ws=await workspace(auth.orgId);
    return locked(auth.orgId,auth.actorId,async()=>{
    const task=await remote.taskrouter.v1.workspaces(ws.workspace_sid!).tasks(input.taskSid).fetch();
    const attrs=JSON.parse(task.attributes) as Record<string,string>;
    const session=await runtime.sessionFor(attrs.call_sid??"");
    if(!session||session.orgId!==auth.orgId)problem("Appel introuvable dans cet espace.",404);
    await validateTarget(auth.orgId,session.lineId,input.destination);
      const call=checked(await db.from("calls").select("ivr_state").eq("id",session.callId).eq("organization_id",auth.orgId).single());
      const state=call!.ivr_state as Record<string,unknown>;
      if(state.operationId===input.operationId)problem("Ce transfert a déjà été demandé. Vérifiez l’appel en direct avant une nouvelle action.",409);
      if(Number(attrs.epoch)!==session.epoch)problem("Cet appel a déjà été transféré. Actualisez la supervision.",409);
      if(!["pending","reserved","assigned","wrapping"].includes(task.assignmentStatus))problem("Cet appel n’est plus transférable.",409);
      const next={...session,epoch:session.epoch+1};
      checked(await db.from("calls").update({ivr_state:{...state,epoch:next.epoch,operationId:input.operationId,transfer:input.destination} as never}).eq("id",session.callId).eq("organization_id",auth.orgId));
      try { await remote.calls(session.callSid).update({url:runtime.url("transfer",next),method:"POST"}); }
      catch (error) {
        const status = (error as {status?:number}).status;
        if (status && status >= 400 && status < 500) {
          checked(await db.from("calls").update({ivr_state:state as never}).eq("id",session.callId).eq("organization_id",auth.orgId));
          problem("Twilio a refusé ce transfert. L’appel conserve son routage précédent.",409);
        }
        problem("Le résultat du transfert est incertain après une coupure réseau. Vérifiez l’appel avant toute nouvelle action.",503);
      }
      // Twilio normally completes the previous Task when its call leaves the queue.
      // Old callbacks are fenced by epoch and cannot terminate the transferred call.
      await audit(auth.orgId,auth.actorId,"voice_call.transfer",session.callId);
      return {transferred:true};
    });
  });
  app.patch<{Params:Params}>(`${root}/tasks/priority`,async(request,reply)=>{
    const auth=await scope(request,reply);if(!auth)return;
    const input=z.object({taskSid:z.string().regex(/^WT[0-9a-fA-F]{32}$/),priority:z.number().int().min(0).max(100)}).strict().parse(request.body);
    const remote=requireProvider(),ws=await workspace(auth.orgId),task=remote.taskrouter.v1.workspaces(ws.workspace_sid!).tasks(input.taskSid);
    const current=await task.fetch();const attrs=JSON.parse(current.attributes);
    if(attrs.organization_id!==auth.orgId)problem("Appel introuvable.",404);
    await task.update({priority:input.priority});return {updated:true};
  });
  app.get<{Params:Params}>(`${root}/voicemails/:id/audio`,async(request,reply)=>{
    const auth=await scope(request,reply);if(!auth)return;requireProvider();
    const recording=checked(await db.from("voice_voicemails").select("recording_sid").eq("organization_id",auth.orgId).eq("id",request.params.id!).maybeSingle());
    if(!recording)problem("Message introuvable.",404);
    const response=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.TWILIO_ACCOUNT_SID}/Recordings/${recording.recording_sid}.mp3`,{headers:{authorization:`Basic ${Buffer.from(`${config.TWILIO_API_KEY_SID}:${config.TWILIO_API_KEY_SECRET}`).toString("base64")}`},signal:AbortSignal.timeout(10000)});
    if(!response.ok)problem("L’enregistrement Twilio n’est pas disponible.",503);
    return reply.type("audio/mpeg").send(Buffer.from(await response.arrayBuffer()));
  });
  runtime.register(app,validate);
  registerTaskRouterWebhooks();
  function registerTaskRouterWebhooks(){
    async function webhookScope(request:FastifyRequest){
      const body=request.body as Record<string,string>;
      if(!validate(request)||body.AccountSid!==config.TWILIO_ACCOUNT_SID)problem("Signature Twilio invalide.",403);
      const ws=checked(await db.from("voice_workspaces").select("*").eq("workspace_sid",body.WorkspaceSid??"").maybeSingle());
      if(!ws)problem("Workspace inconnu.",403);
      return {body,ws};
    }
    app.post("/webhooks/twilio/center/assignment",async(request,reply)=>{
      const {body,ws}=await webhookScope(request);
      if(!config.VOICE_ENABLED || config.OPERATIONS_PAUSED)return {instruction:"reject",activity_sid:ws.activities.offline};
      const attrs=JSON.parse(body.TaskAttributes??"{}") as Record<string,string>;
      const [agentResult,queueResult]=await Promise.all([db.from("voice_agents").select("*").eq("organization_id",ws.organization_id).eq("worker_sid",body.WorkerSid??"").maybeSingle(),db.from("voice_queues").select("*").eq("organization_id",ws.organization_id).eq("queue_sid",body.TaskQueueSid??"").maybeSingle()]);
      const agent=checked(agentResult),queue=checked(queueResult),session=await runtime.sessionFor(attrs.call_sid??"");
      if(!agent||!queue||!session||session.orgId!==ws.organization_id||session.lineId!==queue.line_id||Number(attrs.epoch)!==session.epoch||!queue.config.memberIds.includes(agent.user_id))return {instruction:"reject",activity_sid:ws.activities.offline};
      const contact=checked(await db.rpc("voice_reserve_agent",{p_org_id:ws.organization_id,p_user_id:agent.user_id,p_call_id:session.callId,p_seconds:queue.config.ringTimeout+15,p_reservation_sid:body.ReservationSid??""}));
      if(!contact)return {instruction:"reject",activity_sid:ws.activities.offline};
      if(contact.startsWith("+"))allowedNumber(contact,config);
      return {instruction:"dequeue",to:contact,from:session.to,timeout:queue.config.ringTimeout,post_work_activity_sid:ws.activities.available,status_callback_url:`${base}/webhooks/twilio/center/agent-status?epoch=${session.epoch}&reservation=${body.ReservationSid}`,status_callback_events:"initiated,ringing,answered,completed"};
    });
    app.get("/webhooks/twilio/center/agent-status",async(request,reply)=>{
      const body=request.query as Record<string,string>;
      if(!validate(request)||body.AccountSid!==config.TWILIO_ACCOUNT_SID)return reply.code(403).send();
      const session=await runtime.sessionFor(body.taskCallSid??body.ParentCallSid??"");
      if(!session||Number(body.epoch)!==session.epoch)return reply.code(204).send();
      if(body.CallStatus==="in-progress"){
        if (provider) await provider.calls(session.callSid).update({timeLimit:config.MAX_ACTIVE_CALL_SECONDS});
        checked(await db.from("calls").update({status:"answered",answered_at:new Date().toISOString()}).eq("organization_id",session.orgId).eq("id",session.callId).is("ended_at",null));
        checked(await db.from("call_reservations").update({expires_at:new Date(Date.now()+config.MAX_ACTIVE_CALL_SECONDS*1000).toISOString()}).eq("call_id",session.callId).eq("routing_reservation_sid",body.reservation??"").eq("status","active"));
      }
      if (["completed","busy","no-answer","failed","canceled"].includes(body.CallStatus??"")) checked(await db.from("call_reservations").update({status:"released",expires_at:new Date().toISOString()}).eq("organization_id",session.orgId).eq("call_id",session.callId).eq("routing_reservation_sid",body.reservation??"").eq("status","active"));
      return reply.code(204).send();
    });
    app.post("/webhooks/twilio/center/events",async(request,reply)=>{
      const {body,ws}=await webhookScope(request);
      const attrs=JSON.parse(body.TaskAttributes??"{}") as Record<string,string>;
      if(!uuidSchema.safeParse(attrs.call_id).success || attrs.organization_id!==ws.organization_id)return reply.code(204).send();
      // Release only the worker from this reservation, never other agents on a transfer.
      if(["reservation.rejected","reservation.timeout","reservation.canceled","reservation.rescinded","reservation.completed","task.completed","task.canceled"].includes(body.EventType??"")){
        const agent=body.WorkerSid?checked(await db.from("voice_agents").select("user_id").eq("organization_id",ws.organization_id).eq("worker_sid",body.WorkerSid).maybeSingle()):null;
        if(agent)checked(await db.from("call_reservations").update({status:"released",expires_at:new Date().toISOString()}).eq("organization_id",ws.organization_id).eq("call_id",attrs.call_id!).eq("user_id",agent.user_id).eq("routing_reservation_sid",body.ReservationSid??"").eq("status","active"));
      }
      return reply.code(204).send();
    });
  }
  return {inbound:async(routing:unknown,body:Record<string,string>)=>{
    const r=routing as {flow?:unknown;callId?:string;organizationId?:string;lineId?:string};
    if(!r.flow)return null;
    const flow=voiceFlowSchema.parse(r.flow);
    const session:VoiceSession={callId:r.callId!,orgId:r.organizationId!,lineId:r.lineId!,callSid:body.CallSid!,from:body.From!,to:body.To!,flow,epoch:0};
    return runtime.render(session,isOpen(flow.schedule)?flow.entry:flow.schedule.closed,0,0,true);
  }};
}
