import twilio from "twilio";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { voiceFlowSchema, type VoiceFlow, type VoiceDestination } from "@onoff/contracts";
import type { AppConfig } from "./config.js";
import { checked, problem, type CenterStore } from "./call-center-store.js";
import { allowedNumber, type CenterProvider } from "./call-center-provider.js";

export type VoiceSession = { callId: string; orgId: string; lineId: string; callSid: string; from: string; to: string; flow: VoiceFlow; epoch: number };
type Validate = (request: FastifyRequest) => boolean;
export function isOpen(schedule: VoiceFlow["schedule"], now = new Date()): boolean {
  if (!schedule.enabled) return true;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: schedule.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(part("weekday")) + 1;
  const time = `${part("hour")}:${part("minute")}`;
  if (schedule.opensAt < schedule.closesAt) return schedule.days.includes(day) && time >= schedule.opensAt && time < schedule.closesAt;
  return (schedule.days.includes(day) && time >= schedule.opensAt) || (schedule.days.includes(day === 1 ? 7 : day - 1) && time < schedule.closesAt);
}
export function voiceCenterRuntime(db: CenterStore, provider: CenterProvider | null, config: AppConfig) {
  const base = config.API_PUBLIC_URL.replace(/\/$/, "");
  function url(path: string, session: VoiceSession, params: Record<string, string | number> = {}) {
    return `${base}/webhooks/twilio/center/${path}?${new URLSearchParams(Object.entries({ epoch: session.epoch, ...params }).map(([k,v]) => [k,String(v)]))}`;
  }
  async function sessionFor(callSid: string): Promise<VoiceSession | null> {
    if (!/^CA[0-9a-fA-F]{32}$/.test(callSid)) return null;
    const leg = checked(await db.from("call_legs").select("call_id,organization_id").eq("provider_call_sid", callSid).maybeSingle());
    if (!leg) return null;
    const call = checked(await db.from("calls").select("id,line_id,remote_number,ivr_state,ended_at").eq("organization_id", leg.organization_id).eq("id", leg.call_id).single());
    if (!call || call.ended_at) return null;
    const state = call.ivr_state as { engine?: string; config?: unknown; epoch?: number } | null;
    if (state?.engine !== "taskrouter") return null;
    const line = checked(await db.from("lines").select("phone_number,twilio_account_sid,status").eq("organization_id", leg.organization_id).eq("id", call.line_id).single());
    const organization = checked(await db.from("organizations").select("id").eq("id",leg.organization_id).eq("status","active").maybeSingle());
    if (!organization || !line || line.twilio_account_sid !== config.TWILIO_ACCOUNT_SID || line.status !== "active") return null;
    return { callId: call.id, orgId: leg.organization_id, lineId: call.line_id, from: call.remote_number, to: line.phone_number, callSid, flow: voiceFlowSchema.parse(state.config), epoch: state.epoch ?? 0 };
  }
  async function finish(session: VoiceSession, status: "completed" | "missed", reason: string) {
    checked(await db.from("calls").update({ status, ended_at: new Date().toISOString(), result_code: reason }).eq("id",session.callId).eq("organization_id",session.orgId).is("ended_at",null));
    checked(await db.from("call_reservations").update({ status:"released", expires_at: new Date().toISOString() }).eq("call_id",session.callId).eq("organization_id",session.orgId).eq("status","active"));
  }
  async function render(session: VoiceSession, target: VoiceDestination, depth = 0, attempt = 0, greeting = false): Promise<string> {
    const voice = new twilio.twiml.VoiceResponse();
    const say = (text: string) => voice.say({ language: session.flow.language }, text);
    const french = session.flow.language === "fr-FR";
    if (greeting) { if (session.flow.greetingAudioUrl) voice.play(session.flow.greetingAudioUrl); else if (session.flow.greeting) say(session.flow.greeting); }
    if (depth >= 30) { say(french ? "Veuillez rappeler ultérieurement." : "Please call again later."); voice.hangup(); return voice.toString(); }
    if (target.type === "menu") {
      const menu = session.flow.menus.find(m => m.id === target.menuId);
      if (!menu) problem("Menu introuvable.",503);
      const gather = voice.gather({ input:["dtmf"], numDigits:1, timeout:menu.timeout, actionOnEmptyResult:true, method:"POST", action:url("menu",session,{ menu:menu.id, attempt:attempt+1, depth:depth+1 }) });
      if (attempt) gather.say({ language:session.flow.language }, french ? "Choix non reconnu. Veuillez réessayer." : "Invalid choice. Please try again.");
      gather.say({ language:session.flow.language },menu.prompt);
      for (const option of menu.options) gather.say({ language:session.flow.language }, french ? `Pour ${option.label}, tapez ${option.digit}.` : `For ${option.label}, press ${option.digit}.`);
    } else if (target.type === "queue") {
      const queue = checked(await db.from("voice_queues").select("*").eq("organization_id",session.orgId).eq("line_id",session.lineId).eq("id",target.queueId).maybeSingle());
      if (!queue?.workflow_sid || queue.synced_version !== queue.version) return render(session,{ type:session.flow.noAnswer },depth+1);
      const enqueue = voice.enqueue({ workflowSid:queue.workflow_sid, action:url("queue-exit",session,{ queue:queue.id }), method:"POST", waitUrl:url("wait",session,{ queue:queue.id }), waitUrlMethod:"POST" });
      enqueue.task({ priority:0, timeout:queue.config.maxWaitSeconds }, JSON.stringify({ organization_id:session.orgId, queue_id:queue.id, call_id:session.callId, call_sid:session.callSid, from:session.from, epoch:session.epoch }));
    } else if (target.type === "number") {
      allowedNumber(target.number,config);
      if (target.number === session.to) return render(session,{ type:session.flow.noAnswer },depth+1);
      const dial = voice.dial({ callerId:session.to, answerOnBridge:true, timeout:session.flow.ringTimeout, timeLimit:config.MAX_ACTIVE_CALL_SECONDS, action:url("dial",session), method:"POST" });
      dial.number({ statusCallback:url("leg",session), statusCallbackMethod:"POST", statusCallbackEvent:["initiated","ringing","answered","completed"] },target.number);
    } else if (target.type === "voicemail") {
      say(session.flow.voicemailGreeting);
      voice.record({ maxLength:session.flow.maxRecordingSeconds, playBeep:true, trim:"trim-silence", action:url("recorded",session), method:"POST", recordingStatusCallback:url("recording",session), recordingStatusCallbackMethod:"POST", recordingStatusCallbackEvent:["completed"] });
      voice.hangup();
    } else { say(french ? "Merci de votre appel. Au revoir." : "Thank you for calling. Goodbye."); voice.hangup(); }
    return voice.toString();
  }
  function register(app: FastifyInstance, validate: Validate) {
    const root = "/webhooks/twilio/center";
    const empty = () => new twilio.twiml.VoiceResponse().toString();
    const hangup = () => { const voice = new twilio.twiml.VoiceResponse(); voice.hangup(); return voice.toString(); };
    for (const action of ["menu","wait","queue-exit","dial","recorded","leg","transfer"] as const) {
      app.post(`${root}/${action}`,async(request,reply) => {
        reply.type("text/xml; charset=utf-8");
        const body = request.body as Record<string,string>;
        if (!validate(request) || body.AccountSid !== config.TWILIO_ACCOUNT_SID) return reply.code(403).send(hangup());
        if (!config.VOICE_ENABLED) return reply.code(503).send(hangup());
        const params = new URL(request.url,base).searchParams;
        const session = await sessionFor(action === "leg" ? body.ParentCallSid ?? body.CallSid ?? "" : body.CallSid ?? "");
        if (!session || Number(params.get("epoch")) !== session.epoch) return reply.send(empty());
        if (action === "menu") {
          const menu = session.flow.menus.find(m => m.id === params.get("menu"));
          const attempt = Number(params.get("attempt")), depth = Number(params.get("depth"));
          if (!menu || !Number.isInteger(attempt) || attempt<1 || attempt>menu.maxAttempts || !Number.isInteger(depth) || depth<1 || depth>30) return reply.code(400).send(hangup());
          const option = menu.options.find(o => o.digit === body.Digits);
          return reply.send(await render(session,option?.destination ?? (attempt >= menu.maxAttempts ? menu.fallback : { type:"menu",menuId:menu.id }),depth, option ? 0 : attempt));
        }
        if (action === "wait" || action === "queue-exit") {
          const queue = checked(await db.from("voice_queues").select("*").eq("organization_id",session.orgId).eq("line_id",session.lineId).eq("id",params.get("queue") ?? "").maybeSingle());
          if (!queue) return reply.send(hangup());
          if (action === "queue-exit") {
            if (["bridged","hangup"].includes(body.QueueResult ?? "")) { await finish(session,body.QueueResult === "bridged" ? "completed" : "missed",`queue_${body.QueueResult}`); return reply.send(hangup()); }
            if (["redirected","redirected-from-bridged","bridging-in-process"].includes(body.QueueResult ?? "")) return reply.send(empty());
            return reply.send(await render(session,queue.config.overflow));
          }
          const voice = new twilio.twiml.VoiceResponse();
          if (Number(body.QueueTime ?? 0) >= queue.config.maxWaitSeconds) voice.leave();
          else {
            voice.say({ language:session.flow.language },queue.config.holdMessage);
            if (queue.config.announcePosition && /^\d+$/.test(body.QueuePosition ?? "")) voice.say({ language:session.flow.language },session.flow.language === "fr-FR" ? `Votre position dans la file est ${body.QueuePosition}.` : `Your position in the queue is ${body.QueuePosition}.`);
            if (queue.config.holdMusicUrl) voice.play(queue.config.holdMusicUrl);
            else voice.play("https://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3");
            // Each segment is bounded: Twilio rechecks QueueTime on the next wait request.
          }
          return reply.send(voice.toString());
        }
        if (action === "dial") {
          if (body.DialCallStatus === "completed") { await finish(session,"completed","forward_completed"); return reply.send(hangup()); }
          return reply.send(await render(session,{ type:session.flow.noAnswer }));
        }
        if (action === "recorded") { await finish(session,"completed","voicemail"); return reply.send(hangup()); }
        if (action === "leg") {
          if (body.CallStatus === "in-progress") checked(await db.from("calls").update({ status:"answered",answered_at:new Date().toISOString() }).eq("id",session.callId).is("ended_at",null));
          return reply.send(empty());
        }
        const call = checked(await db.from("calls").select("ivr_state").eq("id",session.callId).eq("organization_id",session.orgId).single());
        const state = call!.ivr_state as { transfer?: VoiceDestination };
        return reply.send(state.transfer ? await render(session,state.transfer) : hangup());
      });
    }
    app.post(`${root}/recording`,async(request,reply) => {
      const body = request.body as Record<string,string>;
      if (!validate(request) || body.AccountSid !== config.TWILIO_ACCOUNT_SID) return reply.code(403).send();
      if (body.RecordingStatus !== "completed") return reply.code(204).send();
      if (!/^RE[0-9a-fA-F]{32}$/.test(body.RecordingSid ?? "") || !/^\d+$/.test(body.RecordingDuration ?? "")) return reply.code(400).send();
      // Recordings arrive after the call ends, so lookup must allow terminal calls.
      const leg = checked(await db.from("call_legs").select("call_id,organization_id").eq("provider_call_sid",body.CallSid ?? "").maybeSingle());
      if (!leg) return reply.code(404).send();
      const call = checked(await db.from("calls").select("ivr_state").eq("id",leg.call_id).eq("organization_id",leg.organization_id).single());
      if ((call!.ivr_state as { engine?:string })?.engine !== "taskrouter") return reply.code(400).send();
      checked(await db.from("voice_voicemails").upsert({ id:crypto.randomUUID(), organization_id:leg.organization_id, call_id:leg.call_id, recording_sid:body.RecordingSid!, duration:Number(body.RecordingDuration), created_at:new Date().toISOString() },{ onConflict:"recording_sid", ignoreDuplicates:true }));
      checked(await db.from("calls").update({status:"completed",result_code:"voicemail"}).eq("id",leg.call_id).eq("organization_id",leg.organization_id));
      return reply.code(204).send();
    });
  }
  return { sessionFor, render, register, url, finish };
}
