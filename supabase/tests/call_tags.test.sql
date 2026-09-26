begin;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000000001','tags@test.invalid'),('00000000-0000-4000-8000-000000000002','outsider@test.invalid');
insert into public.organizations(id,name) values ('10000000-0000-4000-8000-000000000001','Tags');
insert into public.memberships(organization_id,user_id,role) values ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','admin');
insert into public.lines(id,organization_id,phone_number,voice_enabled) values ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','+33102030405',true);
insert into public.line_assignments(organization_id,line_id,user_id,can_voice) values ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',true);
insert into public.calls(id,organization_id,line_id,remote_number,direction,status) values ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','+33601020304','outbound','completed');
insert into public.tags(id,organization_id,name,kind,ai_enabled,prompt) values ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Devis','call',true,'Le client demande un devis.');
insert into public.call_transcriptions(call_id,provider_call_sid,status,snapshot) values ('30000000-0000-4000-8000-000000000001','CA11111111111111111111111111111111','completed','{"segments":[{"speaker":"remote","text":"Quel est le prix ?"}],"partials":{}}');
do $$ begin
 assert (select count(*) from public.tag_subjects)=0,'AI is off by default';
 assert not has_table_privilege('anon','public.tags','select'),'Anonymous cannot read';
 assert not has_table_privilege('authenticated','public.tags','update'),'Clients cannot change prompts directly';
 assert not has_table_privilege('authenticated','public.tag_assignments','insert'),'Clients cannot forge AI attribution';
 assert not has_function_privilege('authenticated','public.claim_tag_job(uuid)','execute'),'Queue is server-only';
end $$;
update public.tag_settings set calls_enabled=true;
update public.call_transcriptions set snapshot='{"segments":[{"speaker":"remote","text":"Je souhaite un devis."}],"partials":{}}';
do $$ declare job public.tag_subjects; rev timestamptz; begin
 assert (select count(*) from public.tag_subjects where status='pending')=1,'Completed transcript queues one job';
 select * into job from public.claim_tag_job();
 assert job.status='processing' and job.attempts=1,'Job is leased';
 assert (select count(*) from public.claim_tag_job())=0,'Cannot claim twice';
 select updated_at into rev from public.tag_settings limit 1;
 assert public.finish_tag_job(job.id,job.lease,rev,'40000000-0000-4000-8000-000000000001',0.96,'completed','Classé'),'Result applies';
 assert (select count(*) from public.tag_assignments where source='ai')=1,'AI assignment persisted';
 -- Rejected AI assignment is remembered across future classification.
 update public.tag_assignments set source='manual',excluded=true,confidence=null;
 update public.tag_subjects set status='pending',retry_at=now();
 select * into job from public.claim_tag_job();
 perform public.finish_tag_job(job.id,job.lease,rev,'40000000-0000-4000-8000-000000000001',0.99,'completed','Classé');
 assert (select count(*) from public.tag_assignments where source='manual' and excluded)=1,'AI does not restore a rejected tag';
 -- Disable while provider request is in flight.
 update public.tag_subjects set status='pending',retry_at=now();
 select * into job from public.claim_tag_job();
 update public.tag_settings set calls_enabled=false;
 assert not public.finish_tag_job(job.id,job.lease,rev,'40000000-0000-4000-8000-000000000001',0.99,'completed','Classé'),'Disabled AI cannot commit';
 assert (select status from public.tag_subjects limit 1)='skipped','Disabled result skipped';
 -- Changing a prompt also invalidates the result.
 update public.tag_settings set calls_enabled=true;
 update public.tag_subjects set status='pending',retry_at=now();
 select updated_at into rev from public.tag_settings limit 1;
 select * into job from public.claim_tag_job();
 update public.tags set prompt='Le client demande une offre chiffrée.';
 assert not public.finish_tag_job(job.id,job.lease,rev,null,0.8,'completed','Aucun'),'Old prompt result cannot commit';
 -- Input changes invalidate a lease.
 update public.tag_subjects set status='pending',retry_at=now();
 select * into job from public.claim_tag_job();
 update public.call_transcriptions set snapshot='{"segments":[{"speaker":"remote","text":"Pas de devis finalement."}],"partials":{}}';
 assert not public.finish_tag_job(job.id,job.lease,rev,null,0.8,'completed','Aucun'),'Old input result cannot commit';
 assert (select status from public.tag_subjects limit 1)='pending','New input is still queued';
 assert public.consume_api_rate_limit('00000000-0000-4000-8000-000000000001','tag_classify',60,1),'Classification rate limiter accepts first';
 assert not public.consume_api_rate_limit('00000000-0000-4000-8000-000000000001','tag_classify',60,1),'Classification rate limiter denies second';
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
do $$ begin
 assert (select count(*) from public.tags)=1,'Member reads catalogue';
 assert (select count(*) from public.tag_subjects)=1,'Voice assignment reads call tags';
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
do $$ begin
 assert (select count(*) from public.tags)=0,'Outsider cannot read catalogue';
 assert (select count(*) from public.tag_assignments)=0,'Outsider cannot read assignments';
end $$;
reset role;
update public.line_assignments set can_voice=false;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
do $$ begin assert (select count(*) from public.tag_subjects)=0,'Revoking voice removes call tag access'; end $$;
reset role;
delete from public.calls;
do $$ begin assert (select count(*) from public.tag_assignments)=0,'Call deletion cascades to assignments'; end $$;
select 'Call tags: RLS, queue leases, AI toggles, stale prompts/inputs, manual corrections and rate limits verified.' as result;
rollback;
