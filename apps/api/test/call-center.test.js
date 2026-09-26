import assert from 'node:assert/strict';
import test from 'node:test';
import twilio from 'twilio';
import { createApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';
import { isOpen, voiceCenterRuntime } from '../dist/call-center-voice.js';
import { defaultVoiceFlow, voiceFlowSchema } from '@onoff/contracts';
const org='10000000-0000-4000-8000-000000000001', user='00000000-0000-4000-8000-000000000001',line='20000000-0000-4000-8000-000000000001',call='30000000-0000-4000-8000-000000000001',queueId='40000000-0000-4000-8000-000000000001';
const sid=p=>p+'1'.repeat(32);
const config=loadConfig({SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'publishable-test',SUPABASE_SECRET_KEY:'test-secret',VOICE_ENABLED:'true',TWILIO_ACCOUNT_SID:sid('AC'),TWILIO_API_KEY_SID:sid('SK'),TWILIO_API_KEY_SECRET:'test-secret',TWILIO_AUTH_TOKEN:'test-token',TWILIO_TWIML_APP_SID:sid('AP'),API_PUBLIC_URL:'https://api.example.com'});
const queue={id:queueId,organization_id:org,line_id:line,version:1,synced_version:1,queue_sid:sid('WQ'),workflow_sid:sid('WW'),config:{name:'Support',memberIds:[user],maxWaitSeconds:60,ringTimeout:20,holdMessage:'Veuillez patienter.',holdMusicUrl:null,announcePosition:true,overflow:{type:'voicemail'}}};
const session={callId:call,orgId:org,lineId:line,callSid:sid('CA'),from:'+33601020304',to:'+33102030405',flow:defaultVoiceFlow(),epoch:0};
function store(options={}){
 const state={role:'admin',epoch:0,ended:false,reserve:'client:agent',queries:[],rpcCalls:[],...options};
 const rows=()=>({memberships:[{role:state.role,user_id:user,organization_id:org,status:'active'}],organizations:[{id:org,status:'active'}],voice_workspaces:[{organization_id:org,workspace_sid:sid('WS'),activities:{offline:sid('WA'),available:'WA'+'2'.repeat(32)}}],voice_queues:[queue],voice_agents:[{organization_id:org,user_id:user,worker_sid:sid('WK'),contact_number:null}],lines:[{id:line,organization_id:org,status:'active',twilio_account_sid:config.TWILIO_ACCOUNT_SID,phone_number:session.to}],calls:[{id:call,line_id:line,organization_id:org,remote_number:session.from,ended_at:state.ended?'2026-01-01T00:00:00Z':null,ivr_state:{engine:'taskrouter',config:session.flow,epoch:state.epoch}}],call_legs:[{provider_call_sid:sid('CA'),call_id:call,organization_id:org}],voice_flows:[],voice_voicemails:[],devices:[],line_assignments:[]} );
 const client={auth:{getUser:async()=>({data:{user:{id:user}},error:null})},from(table){
  const operations=[];let one=false,mutation=false;
  const q={select(){return q},eq(k,v){operations.push([k,v]);return q},not(){return q},is(){return q},in(){return q},order(){return q},limit(){return q},update(values){mutation=true;state.queries.push({table,values,operations});return q},insert(values){mutation=true;state.queries.push({table,values,operations});return q},upsert(values){mutation=true;state.queries.push({table,values,operations});return q},single(){one=true;return q},maybeSingle(){one=true;return q},then(resolve,reject){const data=(rows()[table]??[]).filter(row=>operations.every(([k,v])=>row[k]===v));return Promise.resolve({data:mutation?null:one?data[0]??null:data,error:null}).then(resolve,reject)}};return q;
 },rpc:async(name,args)=>{state.rpcCalls.push({name,args});return {data:name==='voice_reserve_agent'?state.reserve:name==='admin_snapshot'?{members:[],lines:[],assignments:[],audit:[]}:true,error:null}}};return {client,state};
}
function setup(t,options={}){const {client,state}=store(options);const app=createApp(config,{createSupabaseClient:()=>client,centerProvider:{}});t.after(()=>app.close());return {app,state};}
function signed(app,path,body,valid=true){return app.inject({method:'POST',url:path,headers:{'content-type':'application/x-www-form-urlencoded','x-twilio-signature':valid?twilio.getExpectedTwilioSignature(config.TWILIO_AUTH_TOKEN,config.API_PUBLIC_URL+path,body):'invalid'},payload:new URLSearchParams(body).toString()});}
const body={AccountSid:config.TWILIO_ACCOUNT_SID,CallSid:sid('CA'),From:session.from,To:session.to};
test('business hours honor Paris timezone, DST, overnight shifts and weekday boundary',()=>{
 const schedule={...defaultVoiceFlow().schedule,enabled:true};
 assert.equal(isOpen(schedule,new Date('2026-09-25T07:00:00Z')),true);
 assert.equal(isOpen(schedule,new Date('2026-09-25T16:00:00Z')),false);
 assert.equal(isOpen(schedule,new Date('2026-09-26T10:00:00Z')),false);
 assert.equal(isOpen({...schedule,days:[5],opensAt:'22:00',closesAt:'06:00'},new Date('2026-09-26T01:00:00Z')),true);
 assert.equal(isOpen({...schedule,days:[7],opensAt:'22:00',closesAt:'06:00'},new Date('2026-09-28T01:00:00Z')),true);
 assert.equal(isOpen(schedule,new Date('2026-12-25T08:00:00Z')),true);
});
test('flow validation rejects duplicate digits, removed menu references and invalid timezones',()=>{
 const flow=defaultVoiceFlow();assert.equal(voiceFlowSchema.safeParse(flow).success,true);
 assert.equal(voiceFlowSchema.safeParse({...flow,entry:{type:'menu',menuId:'missing'}}).success,false);
 flow.menus[0].options.push(flow.menus[0].options[0]);assert.equal(voiceFlowSchema.safeParse(flow).success,false);
 assert.equal(voiceFlowSchema.safeParse({...defaultVoiceFlow(),schedule:{...flow.schedule,timezone:'Not/AZone'}}).success,false);
});
test('TwiML contains real TaskRouter enqueue, scoped callback, timeout and source identity',async()=>{
 const {client}=store();const runtime=voiceCenterRuntime(client,null,config);
 const xml=await runtime.render(session,{type:'queue',queueId});
 assert.match(xml,new RegExp(`workflowSid="${sid('WW')}"`));assert.match(xml,/timeout="60"/);assert.match(xml,/queue_id/);assert.match(xml,/epoch=0/);
 assert.match(xml, /<Task/);assert.doesNotMatch(xml,/<Dial/);
});
test('TwiML escapes prompts, forwards with owned caller ID and records bounded voicemail',async()=>{
 const {client}=store(),runtime=voiceCenterRuntime(client,null,config),flow=defaultVoiceFlow();flow.greeting='Bonjour <équipe> & bienvenue';
 const xml=await runtime.render({...session,flow},flow.entry,0,0,true);assert.match(xml,/&lt;équipe&gt; &amp; bienvenue/);assert.match(xml,/actionOnEmptyResult="true"/);
 const forward=await runtime.render(session,{type:'number',number:'+33611223344'});assert.match(forward,/callerId="\+33102030405"/);assert.match(forward,/<Number[^>]*>\+33611223344<\/Number>/);
 await assert.rejects(()=>runtime.render(session,{type:'number',number:'+14155550123'}),/pays/);
 const voicemail=await runtime.render(session,{type:'voicemail'});assert.match(voicemail,/maxLength="120"/);assert.match(voicemail,/recordingStatusCallback=/);
});
test('center routes deny unauthenticated, member and cross-tenant access before provider mutations',async t=>{
 const {app,state}=setup(t);const base=`/v1/organizations/${org}/center`;
 assert.equal((await app.inject({url:base})).statusCode,401);
 state.role='member';assert.equal((await app.inject({url:base,headers:{authorization:'Bearer session'}})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:base+'/setup',headers:{authorization:'Bearer session'}})).statusCode,403);
 state.role='admin';assert.equal((await app.inject({url:'/v1/organizations/10000000-0000-4000-8000-000000000002/center',headers:{authorization:'Bearer session'}})).statusCode,403);
 assert.equal(state.queries.length,0);
});
test('invalid configuration yields 400 before any configuration write',async t=>{
 const {app,state}=setup(t);const response=await app.inject({method:'PUT',url:`/v1/organizations/${org}/center/flows/${line}`,headers:{authorization:'Bearer session'},payload:{config:{},version:0,publish:true}});
 assert.equal(response.statusCode,400);assert.equal(state.queries.length,0);
});
test('signed menu handles invalid/no input retries, fallbacks and spoofed webhook rejection',async t=>{
 const {app}=setup(t);const path='/webhooks/twilio/center/menu?epoch=0&menu=accueil&attempt=1&depth=1';
 assert.equal((await signed(app,path,body,false)).statusCode,403);
 assert.equal((await signed(app,path,{...body,AccountSid:'AC'+'2'.repeat(32)})).statusCode,403);
 const retry=await signed(app,path,{...body,Digits:'9'});assert.equal(retry.statusCode,200);assert.match(retry.body,/attempt=2/);
 const fallback=await signed(app,path.replace('attempt=1','attempt=2'),body);assert.match(fallback.body,/<Record/);
 const selected=await signed(app,path,{...body,Digits:'1'});assert.match(selected.body,/<Record/);
});
test('queue wait exits at deadline and failed forwarding reaches actual voicemail',async t=>{
 const {app}=setup(t);
 const wait=await signed(app,`/webhooks/twilio/center/wait?epoch=0&queue=${queueId}`,{...body,QueueTime:'60'});assert.match(wait.body,/<Leave/);
 const exit=await signed(app,`/webhooks/twilio/center/queue-exit?epoch=0&queue=${queueId}`,{...body,QueueResult:'leave'});assert.match(exit.body,/<Record/);
 const dial=await signed(app,'/webhooks/twilio/center/dial?epoch=0',{...body,DialCallStatus:'no-answer'});assert.match(dial.body,/<Record/);
});
test('callbacks from before a transfer cannot hang up or finish the redirected call',async t=>{
 const {app,state}=setup(t,{epoch:1});
 const response=await signed(app,`/webhooks/twilio/center/queue-exit?epoch=0&queue=${queueId}`,{...body,QueueResult:'bridged'});
 assert.equal(response.statusCode,200);assert.doesNotMatch(response.body,/<Hangup/);assert.equal(state.queries.length,0);
});
test('assignment requires an atomic reservation and rejects unreachable/busy agents',async t=>{
 const {app,state}=setup(t);const payload={...body,WorkspaceSid:sid('WS'),TaskQueueSid:sid('WQ'),WorkerSid:sid('WK'),ReservationSid:sid('WR'),TaskAttributes:JSON.stringify({organization_id:org,call_sid:sid('CA'),call_id:call,epoch:0})};
 const assigned=await signed(app,'/webhooks/twilio/center/assignment',payload);assert.equal(assigned.statusCode,200);assert.equal(assigned.json().instruction,'dequeue');assert.equal(assigned.json().to,'client:agent');assert.equal(state.rpcCalls.at(-1).args.p_reservation_sid,sid('WR'));
 state.reserve=null;const rejected=await signed(app,'/webhooks/twilio/center/assignment',payload);assert.equal(rejected.json().instruction,'reject');
});
test('live provider failure is explicit and never manufactures available agents or queue counters',async t=>{
 const {app}=setup(t);const response=await app.inject({url:`/v1/organizations/${org}/center`,headers:{authorization:'Bearer session'}});
 assert.equal(response.statusCode,200);assert.equal(response.json().live,false);assert.deepEqual(response.json().statistics,[]);assert.match(response.json().liveError,/Twilio/);
});
