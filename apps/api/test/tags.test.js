import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { registerTags } from '../dist/tags.js';
const org='10000000-0000-4000-8000-000000000001', user='20000000-0000-4000-8000-000000000001', call='30000000-0000-4000-8000-000000000001', tag='40000000-0000-4000-8000-000000000001', contact='50000000-0000-4000-8000-000000000001';
function setup(t, options={}) {
 const state={ allowed:true, role:'admin', rateAllowed:true, classified:0, tables:{
  memberships:[{organization_id:org,user_id:user,role:'admin',status:'active'}],
  calls:[{id:call,organization_id:org}], contacts:[{id:contact,organization_id:org,display_name:'Client',email:null,archived_at:null}],
  tag_settings:[{organization_id:org,calls_enabled:true,confidence_threshold:.85,updated_at:'2026-09-26T12:00:00Z'}],
  tags:[{id:tag,organization_id:org,name:'Devis',kind:'call',ai_enabled:true,color:'#246653',prompt:'Le client demande un devis.',updated_at:'2026-09-26T12:00:00Z'}],
  tag_subjects:[],tag_assignments:[],call_transcriptions:[{call_id:call,status:'completed',snapshot:{segments:[{speaker:'remote',text:'Un devis SVP'}]}}]
 }};
 function db(isUser=false) { return { from(table) {
  let filters=[], single=false, mode=null, value, opts={};
  const query={select(){return query;},eq(k,v){filters.push(r=>r[k]===v);return query;},is(k,v){return query.eq(k,v);},order(){return query;},single(){single=true;return query;},maybeSingle(){single=true;return query;},insert(v){mode='insert';value=v;return query;},upsert(v,o){mode='upsert';value=v;opts=o??{};return query;},update(v){mode='update';value=v;return query;},delete(){mode='delete';return query;},then(resolve,reject){
   let all=state.tables[table], rows=all.filter(r=>filters.every(f=>f(r)));
   if(isUser && !state.allowed) rows=[];
   if(table==='memberships') rows=rows.map(r=>({...r,role:state.role}));
   if(mode==='insert'||mode==='upsert'){
    let row=mode==='upsert'?all.find(r=> opts.onConflict ? r[opts.onConflict]===value[opts.onConflict] : table==='tag_assignments'?r.subject_id===value.subject_id&&r.tag_id===value.tag_id:r.organization_id===value.organization_id):null;
    if(!row){row={id:randomUUID(),updated_at:new Date().toISOString(),status:'idle',context:'',message:null,attempts:0,...value};all.push(row);} else if(!opts.ignoreDuplicates) Object.assign(row,value);
    rows=[row];
   } else if(mode==='update') rows.forEach(r=>Object.assign(r,value));
   else if(mode==='delete') state.tables[table]=all.filter(r=>!rows.includes(r));
   if(table==='tag_assignments') rows=rows.map(r=>({...r,tags:state.tables.tags.find(t=>t.id===r.tag_id)}));
   return Promise.resolve({data:structuredClone(single?rows[0]??null:rows),error:null}).then(resolve,reject);
  }};return query;
 }, async rpc(name,args={}){
  if(name==='consume_api_rate_limit')return {data:state.rateAllowed,error:null};
  if(name==='claim_tag_job'){const job=state.tables.tag_subjects.find(s=>s.status==='pending'&&(!s.retry_at||Date.parse(s.retry_at)<=Date.now()));if(!job)return {data:[],error:null};job.status='processing';job.lease=randomUUID();job.attempts++;return {data:[structuredClone(job)],error:null};}
  if(name==='finish_tag_job'){const job=state.tables.tag_subjects.find(s=>s.id===args.p_id&&s.lease===args.p_lease);if(job){job.status=args.p_status;job.message=args.p_message;job.retry_at=new Date(Date.now()+30000).toISOString();job.lease=null;}return {data:Boolean(job),error:null};}
  throw new Error(name);
 }};}
 const app=Fastify();app.decorateRequest('context',null);app.addHook('preHandler',async(req,reply)=>{if(!req.headers.authorization)return reply.code(401).send();req.context={userId:user,supabase:db(true)};});
 app.setErrorHandler((err,req,reply)=>reply.code(err.statusCode??(err.name==='ZodError'?400:500)).send({message:err.message}));
 registerTags(app,{OPERATIONS_PAUSED:false},db(),options.unavailable?undefined:async()=>{state.classified++;return {tagId:tag,confidence:.95,model:'jev-1.13.0'};});
 t.after(()=>app.close());
 const request=(method,url,payload)=>app.inject({method,url,headers:{authorization:'Bearer test'},...(payload?{payload}:{})});
 return {app,state,request};
}
test('tags require authentication and organisation membership',async t=>{const {app,state,request}=setup(t);assert.equal((await app.inject(`/v1/organizations/${org}/tags`)).statusCode,401);state.allowed=false;assert.equal((await request('GET',`/v1/organizations/${org}/tags`)).statusCode,403);});
test('members read catalogue but cannot edit tags or AI settings',async t=>{const {state,request}=setup(t);state.role='member';assert.equal((await request('GET',`/v1/organizations/${org}/tags`)).json().canManage,false);assert.equal((await request('POST',`/v1/organizations/${org}/tags`,{name:'Tag',kind:'call'})).statusCode,403);assert.equal((await request('PUT',`/v1/organizations/${org}/tag-settings`,{callsEnabled:false,confidenceThreshold:.85})).statusCode,403);});
test('admin creates manual tags and edits prompts, refusing blank AI prompts and scope changes',async t=>{const {request}=setup(t);assert.equal((await request('POST',`/v1/organizations/${org}/tags`,{name:'À rappeler',kind:'call'})).statusCode,201);assert.equal((await request('PUT',`/v1/tags/${tag}`,{name:'Devis',kind:'call',aiEnabled:true,prompt:''})).statusCode,400);assert.equal((await request('PUT',`/v1/tags/${tag}`,{name:'Devis',kind:'contact'})).statusCode,400);});
test('manual correction writes a durable exclusion; cross-kind tag and revoked access are denied',async t=>{const {state,request}=setup(t);assert.equal((await request('PUT',`/v1/tagging/call/${call}/tags/${tag}`,{assigned:false})).statusCode,200);assert.equal(state.tables.tag_assignments[0].excluded,true);assert.equal((await request('PUT',`/v1/tagging/contact/${contact}/tags/${tag}`,{assigned:true})).statusCode,400);state.allowed=false;assert.equal((await request('GET',`/v1/tagging/call/${call}`)).statusCode,404);});
test('missing provider cannot enable AI, but can always disable it',async t=>{const {state,request}=setup(t,{unavailable:true});assert.equal((await request('PUT',`/v1/organizations/${org}/tag-settings`,{callsEnabled:false,confidenceThreshold:.85})).statusCode,200);assert.equal((await request('PUT',`/v1/organizations/${org}/tag-settings`,{callsEnabled:true,confidenceThreshold:.85})).statusCode,409);assert.equal(state.tables.tag_settings[0].calls_enabled,false);});
test('classification respects switch and rate limit before paying provider',async t=>{const {state,request}=setup(t);state.tables.tag_settings[0].calls_enabled=false;assert.equal((await request('POST',`/v1/tagging/call/${call}/classify`)).statusCode,409);state.tables.tag_settings[0].calls_enabled=true;state.rateAllowed=false;assert.equal((await request('POST',`/v1/tagging/call/${call}/classify`)).statusCode,429);assert.equal(state.classified,0);});
test('classification queues and consumes completed transcript; live transcript is skipped',async t=>{const {state,request}=setup(t);state.tables.call_transcriptions[0].status='live';assert.equal((await request('POST',`/v1/tagging/call/${call}/classify`)).statusCode,202);await new Promise(r=>setTimeout(r,20));assert.equal(state.classified,0);assert.equal(state.tables.tag_subjects[0].status,'skipped');state.tables.call_transcriptions[0].status='completed';await request('POST',`/v1/tagging/call/${call}/classify`);await new Promise(r=>setTimeout(r,20));assert.equal(state.classified,1);assert.equal(state.tables.tag_subjects[0].status,'completed');});
test('contact classification and free context are not exposed',async t=>{
 const {request}=setup(t);
 assert.equal((await request('POST',`/v1/tagging/contact/${contact}/classify`)).statusCode,400);
 assert.equal((await request('PUT',`/v1/tagging/call/${call}/context`,{context:'Any context'})).statusCode,404);
});
