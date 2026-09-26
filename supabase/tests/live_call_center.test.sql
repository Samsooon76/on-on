-- Run after all migrations in an isolated database. No persistent fixtures.
begin;
insert into auth.users(id,email) values
('00000000-0000-4000-8000-000000000001','admin@admin-test.invalid'),
('00000000-0000-4000-8000-000000000002','member@admin-test.invalid'),
('00000000-0000-4000-8000-000000000003','other@admin-test.invalid');
insert into public.organizations(id,name) values('10000000-0000-4000-8000-000000000001','Admin test'),('10000000-0000-4000-8000-000000000002','Other tenant');
insert into public.memberships(organization_id,user_id,role) values
('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','admin'),
('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','member'),
('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','admin');
insert into public.lines(id,organization_id,phone_number,twilio_account_sid,voice_enabled,sms_enabled) values
('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','+33102030405','AC11111111111111111111111111111111',true,true);
insert into public.line_assignments(organization_id,line_id,user_id,can_voice,can_sms) values
('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',true,true),
('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',true,false);
insert into public.devices(id,organization_id,user_id,platform,label,voice_identity,voice_registered_at,last_active_at) values
('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','web','Admin browser','web_admin',now(),now()),
('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','ios','Member phone','mobile_member',now(),now());

do $$
declare
 org uuid := '10000000-0000-4000-8000-000000000001';
 actor uuid := '00000000-0000-4000-8000-000000000001';
 member uuid := '00000000-0000-4000-8000-000000000002';
 outsider uuid := '00000000-0000-4000-8000-000000000003';
 line uuid := '20000000-0000-4000-8000-000000000001';
 queue uuid := '40000000-0000-4000-8000-000000000001';
 token uuid := gen_random_uuid();
 cfg jsonb := '{"name":"Support","enabled":true,"language":"fr-FR","greeting":"Bonjour","entry":{"type":"queue","queueId":"40000000-0000-4000-8000-000000000001"},"schedule":{"closed":{"type":"voicemail"}},"menus":[]}';
 result jsonb; first_call uuid; second_call uuid; reservation text := 'WR11111111111111111111111111111111';
begin
 assert not has_table_privilege('authenticated','public.voice_workspaces','select'), 'Provider IDs stay private';
 assert not has_table_privilege('anon','public.voice_voicemails','select'), 'Recordings stay private';
 assert not has_function_privilege('authenticated','public.voice_flow_save(uuid,uuid,uuid,jsonb,integer,boolean)','execute'), 'Flows cannot bypass API validation';
 begin perform public.voice_center_lock(org,member,token); raise exception 'Non-admin provisioned'; exception when insufficient_privilege then null; end;
 begin perform public.voice_center_lock(org,outsider,token); raise exception 'Other tenant provisioned'; exception when insufficient_privilege then null; end;
 assert public.voice_center_lock(org,actor,token), 'First writer acquires lease';
 assert not public.voice_center_lock(org,actor,gen_random_uuid()), 'Concurrent writer is excluded';
 assert not public.voice_center_lock(org,actor,gen_random_uuid(),true), 'Wrong owner cannot unlock';
 assert public.voice_center_lock(org,actor,token,true), 'Lease released';
 insert into public.voice_queues(id,organization_id,line_id,config,workflow_sid,version,synced_version)
 values(queue,org,line,'{}','WW11111111111111111111111111111111',1,1);
 begin perform public.voice_flow_save(org,outsider,line,cfg,0,true); raise exception 'Foreign publisher'; exception when insufficient_privilege then null; end;
 begin perform public.voice_flow_save(org,actor,line,jsonb_set(cfg,'{entry,queueId}','"40000000-0000-4000-8000-000000000002"'),0,true); raise exception 'Foreign queue accepted'; exception when foreign_key_violation then null; end;
 assert public.voice_flow_save(org,actor,line,cfg,0,false)=1, 'Draft created';
 assert (select published is null from public.voice_flows where line_id=line), 'Draft is not live';
 begin perform public.voice_flow_save(org,actor,line,cfg,0,true); raise exception 'Stale publish'; exception when serialization_failure then null; end;
 assert public.voice_flow_save(org,actor,line,cfg,1,true)=2, 'Published';
 result := public.begin_inbound_call('AC11111111111111111111111111111111','CA11111111111111111111111111111111','+33601020304','+33102030405',4);
 first_call := (result->>'callId')::uuid;
 assert result->'flow'=cfg, 'Real call gets published flow';
 assert not exists(select 1 from public.call_reservations where call_id=first_call), 'IVR does not seize agents';
 perform public.voice_flow_save(org,actor,line,jsonb_set(cfg,'{greeting}','"New greeting"'),2,true);
 result := public.begin_inbound_call('AC11111111111111111111111111111111','CA11111111111111111111111111111111','+33601020304','+33102030405',4);
 assert result->'flow'=cfg and (result->>'callId')::uuid=first_call, 'Retry preserves snapshot and call ID';
 perform public.apply_call_status('AC11111111111111111111111111111111','CA11111111111111111111111111111111','CA11111111111111111111111111111111','in-progress',null,null,null);
 assert (select answered_at is null from public.calls where id=first_call), 'Reading the IVR is not an agent answering';
 insert into public.voice_agents(organization_id,user_id,worker_sid) values(org,member,'WK11111111111111111111111111111111');
 assert public.voice_reserve_agent(org,member,first_call,60,reservation)='client:mobile_member', 'Routes to actual registered device';
 assert public.voice_reserve_agent(org,member,first_call,60,reservation)='client:mobile_member', 'Same reservation retries safely';
 assert public.voice_reserve_agent(org,member,first_call,60,'WR22222222222222222222222222222222') is null, 'Different reservation cannot claim occupied worker';
 result := public.begin_inbound_call('AC11111111111111111111111111111111','CA22222222222222222222222222222222','+33601020304','+33102030405',4);
 second_call := (result->>'callId')::uuid;
 assert public.voice_reserve_agent(org,member,second_call,60,'WR22222222222222222222222222222222') is null, 'Second call cannot seize same agent';
 perform public.apply_call_status('AC11111111111111111111111111111111','CA11111111111111111111111111111111','CA11111111111111111111111111111111','completed',42,null,null);
 assert (select status='missed' from public.calls where id=first_call), 'Abandoning IVR is a missed call';
 assert not exists(select 1 from public.call_reservations where call_id=first_call and status='active'), 'Terminal callback releases reservation';
 update public.memberships set status='suspended' where organization_id=org and user_id=member;
 assert public.voice_reserve_agent(org,member,second_call,60,'WR22222222222222222222222222222222') is null, 'Suspended member excluded immediately';
 update public.memberships set status='active' where organization_id=org and user_id=member;
 update public.line_assignments set can_voice=false where organization_id=org and user_id=member;
 assert public.voice_reserve_agent(org,member,second_call,60,'WR22222222222222222222222222222222') is null, 'Revoked line permission excluded immediately';
 update public.voice_queues set version=2 where id=queue;
 begin perform public.voice_flow_save(org,actor,line,cfg,3,true); raise exception 'Unsynced queue published'; exception when foreign_key_violation then null; end;
end $$;
select 'ok - Live call center authorization, publication, snapshots and reservations';
rollback;
