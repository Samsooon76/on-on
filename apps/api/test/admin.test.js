import assert from 'node:assert/strict';
import test from 'node:test';
import twilio from 'twilio';
import { createApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';
import { defaultIvrConfig } from '@onoff/contracts';

const orgId='10000000-0000-4000-8000-000000000001', actorId='00000000-0000-4000-8000-000000000001', memberId='00000000-0000-4000-8000-000000000002', lineId='20000000-0000-4000-8000-000000000001';
const base=`/v1/organizations/${orgId}/admin`, headers={authorization:'Bearer session'};
const config=loadConfig({SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'test-publishable',SUPABASE_SECRET_KEY:'test-secret',TWILIO_ACCOUNT_SID:`AC${'1'.repeat(32)}`,TWILIO_AUTH_TOKEN:'test-auth',VOICE_ENABLED:'true',TWILIO_API_KEY_SID:`SK${'2'.repeat(32)}`,TWILIO_API_KEY_SECRET:'test-secret',TWILIO_TWIML_APP_SID:`AP${'3'.repeat(32)}`,API_PUBLIC_URL:'https://api.example.com'});
function setup(t, options={}) {
 const state={role:'admin',rpcs:[],created:[],deleted:[],authError:null,rpcError:null,checkData:[],checkError:null, ...options};
 const client={auth:{getUser:async()=>({data:{user:{id:actorId}},error:null}),admin:{createUser:async input=>{state.created.push(input);return {data:{user:state.authError ? null : {id:memberId}},error:state.authError}},deleteUser:async id=>{state.deleted.push(id);return {error:null}}}},
 from(){ const q={select:()=>q,eq:()=>q,limit:()=>q,maybeSingle:async()=>({data:state.role?{role:state.role}:null,error:null}),then:(resolve,reject)=>Promise.resolve({data:state.checkData,error:state.checkError}).then(resolve,reject)};return q;},
 rpc:async(name,args)=>{state.rpcs.push({name,args});return {data:state.rpcError ? null : name==='admin_snapshot' ? {members:[],lines:[],assignments:[],audit:[]} : name.includes('inbound') ? state.routing : memberId,error:state.rpcError}}};
 const app=createApp(config,{createSupabaseClient:()=>client});t.after(()=>app.close());return {app,state};
}
const member={email:'new@example.test',password:'initial-password-42',displayName:'Camille Martin',role:'member'};
test('all admin endpoints require authentication and active admin membership',async t=>{
 const {app,state}=setup(t);
 for(const [method,url,payload] of [['GET',base],['POST',`${base}/members`,member],['PATCH',`${base}/members/${memberId}`,{}],['PUT',`${base}/lines/${lineId}/ivr`,{}]]) {
  assert.equal((await app.inject({method,url,...(payload?{payload}:{})})).statusCode,401);
  for(const role of ['member',null]) {state.role=role;assert.equal((await app.inject({method,url,headers,...(payload?{payload}:{})})).statusCode,403);}
 }
 assert.equal(state.rpcs.length,0);assert.equal(state.created.length,0);
});
test('admin create validates input before touching Auth and uses server actor and tenant',async t=>{
 const {app,state}=setup(t);
 assert.equal((await app.inject({method:'POST',url:`${base}/members`,headers,payload:{...member,password:'short'}})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url:`${base}/members`,headers,payload:{...member,actorId:memberId}})).statusCode,400);
 assert.equal(state.created.length,0);
 const response=await app.inject({method:'POST',url:`${base}/members`,headers,payload:member});
 assert.equal(response.statusCode,201);assert.deepEqual(response.json(),{id:memberId});assert.ok(!response.body.includes(member.password));
 assert.equal(state.rpcs[0].args.p_actor_id,actorId);assert.equal(state.rpcs[0].args.p_org_id,orgId);
});
test('existing emails are never overwritten and failed membership creation is compensated',async t=>{
 const {app,state}=setup(t,{authError:{code:'email_exists'}});
 assert.equal((await app.inject({method:'POST',url:`${base}/members`,headers,payload:member})).statusCode,409);
 assert.equal(state.rpcs.length,0);assert.equal(state.deleted.length,0);
 state.authError=null;state.rpcError={code:'42501'};
 assert.equal((await app.inject({method:'POST',url:`${base}/members`,headers,payload:member})).statusCode,403);assert.deepEqual(state.deleted,[memberId]);
});
test('an ambiguous commit never deletes a successfully attached account',async t=>{
 const {app,state}=setup(t,{rpcError:{code:'XX000'},checkData:[{user_id:memberId,organization_id:orgId}]});
 assert.equal((await app.inject({method:'POST',url:`${base}/members`,headers,payload:member})).statusCode,201);assert.equal(state.deleted.length,0);
 state.checkData=[];state.checkError={code:'unavailable'};
 assert.equal((await app.inject({method:'POST',url:`${base}/members`,headers,payload:member})).statusCode,503);assert.equal(state.deleted.length,0);
});
test('last admin, stale edits and foreign IVR targets return actionable errors',async t=>{
 const {app,state}=setup(t);
 for(const [code,status] of [['23514',409],['40001',409],['42501',403],['P0002',404]]) {state.rpcError={code};assert.equal((await app.inject({method:'PATCH',url:`${base}/members/${memberId}`,headers,payload:{displayName:'Camille',role:'member',status:'active',version:new Date().toISOString()}})).statusCode,status);}
 state.rpcError={code:'23503'};
 assert.equal((await app.inject({method:'PUT',url:`${base}/lines/${lineId}/ivr`,headers,payload:{config:{...defaultIvrConfig,enabled:true,options:[{digit:'1',label:'Support',userId:memberId}]},version:new Date().toISOString()}})).statusCode,400);
});
test('IVR rejects duplicate digits and client-supplied destinations',async t=>{
 const {app,state}=setup(t);const option={digit:'1',label:'Support',userId:memberId};
 for(const options of [[option,option],[{...option,phoneNumber:'+33123456789'}]]) {
  assert.equal((await app.inject({method:'PUT',url:`${base}/lines/${lineId}/ivr`,headers,payload:{config:{...defaultIvrConfig,enabled:true,options},version:new Date().toISOString()}})).statusCode,400);
 }
 assert.equal(state.rpcs.length,0);
});
test('signed IVR webhooks produce bounded DTMF menus and preserve server-side routing',async t=>{
 const {app,state}=setup(t,{routing:{allowed:true,ivr:{...defaultIvrConfig,enabled:true,greeting:'Bonjour <équipe> & bienvenue',options:[{digit:'1',label:'Support',userId:memberId}]},attempt:0}});
 const body={AccountSid:config.TWILIO_ACCOUNT_SID,CallSid:`CA${'1'.repeat(32)}`,From:'+33601020304',To:'+33102030405'};
 async function webhook(url,params,valid=true){return app.inject({method:'POST',url,headers:{'content-type':'application/x-www-form-urlencoded','x-twilio-signature':valid ? twilio.getExpectedTwilioSignature(config.TWILIO_AUTH_TOKEN,config.API_PUBLIC_URL+url,params) : 'invalid'},payload:new URLSearchParams(params).toString()});}
 const menu=await webhook('/webhooks/twilio/voice/inbound',body);
 assert.equal(menu.statusCode,200);assert.match(menu.body,/actionOnEmptyResult="true"/);assert.match(menu.body,/voice\/ivr\?attempt=1/);assert.match(menu.body,/&lt;équipe&gt; &amp; bienvenue/);assert.doesNotMatch(menu.body,/<Dial/);
 assert.equal((await webhook('/webhooks/twilio/voice/ivr?attempt=1',{...body,Digits:'1'},false)).statusCode,403);
 assert.equal((await webhook('/webhooks/twilio/voice/ivr?attempt=99',{...body,Digits:'1'})).statusCode,400);
 state.routing={allowed:true,callId:memberId,devices:[{identity:'mobile_member',deviceId:memberId}]};
 const dial=await webhook('/webhooks/twilio/voice/ivr?attempt=1',{...body,Digits:'1'});
 assert.equal(dial.statusCode,200);assert.match(dial.body,/<Identity>mobile_member<\/Identity>/);assert.equal(state.rpcs.at(-1).name,'route_inbound_call');assert.equal(state.rpcs.at(-1).args.p_digits,'1');assert.equal(state.rpcs.at(-1).args.p_attempt,1);
});
