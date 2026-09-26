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
 cfg jsonb := '{"enabled":true,"greeting":"Bonjour","language":"fr-FR","timeout":5,"maxAttempts":2,"fallback":"all","options":[{"digit":"1","label":"Support","userId":"00000000-0000-4000-8000-000000000002"}]}';
 result jsonb; version timestamptz; v_test_call_id uuid;
begin
 assert not has_function_privilege('authenticated','public.admin_snapshot(uuid,uuid)','execute'), 'Member cannot invoke service RPC';
 assert not has_function_privilege('anon','public.route_inbound_call(text,text,text,text,integer,text,integer)','execute'), 'Anonymous cannot invoke routing';
 assert not has_table_privilege('authenticated','public.memberships','update'), 'No direct privilege escalation';
 begin perform public.admin_snapshot(org,member); raise exception 'Member got admin snapshot'; exception when insufficient_privilege then null; end;
 begin perform public.admin_snapshot(org,outsider); raise exception 'Cross-tenant admin access'; exception when insufficient_privilege then null; end;
 result := public.admin_snapshot(org,actor);
 assert jsonb_array_length(result->'members') = 2, 'Snapshot tenant isolation';
 assert not (result::text like '%other@admin-test.invalid%'), 'No unrelated account leaks';
 select updated_at into version from public.memberships where organization_id=org and user_id=actor;
 begin perform public.admin_update_member(org,actor,actor,'Admin','member','active',version); raise exception 'Last admin demoted'; exception when check_violation then null; end;
 begin perform public.admin_update_member(org,actor,actor,'Admin','admin','suspended',version); raise exception 'Last admin suspended'; exception when check_violation then null; end;
 begin perform public.admin_update_member(org,actor,member,'Member','member','active','2000-01-01'); raise exception 'Stale edit accepted'; exception when serialization_failure then null; end;
 select updated_at into version from public.lines where id=line;
 begin perform public.admin_set_ivr(org,actor,line,jsonb_set(cfg,'{options,0,userId}',to_jsonb(outsider::text)),version); raise exception 'Foreign IVR target'; exception when foreign_key_violation then null; end;
 begin perform public.admin_set_ivr(org,actor,line,jsonb_set(cfg,'{options}',(cfg->'options')||(cfg->'options')),version); raise exception 'Duplicate IVR digit'; exception when invalid_parameter_value then null; end;
 begin perform public.admin_set_ivr(org,actor,line,jsonb_set(cfg,'{language}','null'),version); raise exception 'Null language accepted'; exception when invalid_parameter_value then null; end;
 perform public.admin_set_ivr(org,actor,line,cfg,version);
 result := public.begin_inbound_call('AC11111111111111111111111111111111','CA11111111111111111111111111111111','+33601020304','+33102030405',4);
 assert result->'ivr' = cfg, 'Initial call gets menu';
 v_test_call_id := (result->>'callId')::uuid;
 assert not exists(select 1 from public.call_reservations where call_reservations.call_id = v_test_call_id), 'Menu does not reserve recipients';
 assert (select count(*) from public.calls where id=v_test_call_id) = 1, 'Call tracked before selection';
 -- Change live configuration: the caller keeps the snapshot.
 update public.lines set ivr_config=jsonb_set(cfg,'{greeting}','"Changed"') where id=line;
 result := public.route_inbound_call('AC11111111111111111111111111111111','CA11111111111111111111111111111111','+33601020304','+33102030405',4,'9',1);
 assert result->'ivr' = cfg and result->>'attempt' = '1', 'Invalid input retries snapshot';
 result := public.route_inbound_call('AC11111111111111111111111111111111','CA11111111111111111111111111111111','+33601020304','+33102030405',4,'9',1);
 assert result->>'attempt' = '1', 'Webhook retry does not consume an attempt';
 result := public.route_inbound_call('AC11111111111111111111111111111111','CA11111111111111111111111111111111','+33601020304','+33102030405',4,'1',2);
 assert jsonb_array_length(result->'devices') = 1 and result->'devices'->0->>'identity' = 'mobile_member', 'Selection routes only to assigned mobile member';
 result := public.route_inbound_call('AC11111111111111111111111111111111','CA11111111111111111111111111111111','+33601020304','+33102030405',4,'0',2);
 assert result->'devices'->0->>'identity' = 'mobile_member', 'Choice replay does not change target';
 update public.call_reservations set status='released',expires_at=now();
 -- No answer falls back to all eligible recipients after the configured attempts.
 result := public.begin_inbound_call('AC11111111111111111111111111111111','CA22222222222222222222222222222222','+33601020304','+33102030405',4);
 result := public.route_inbound_call('AC11111111111111111111111111111111','CA22222222222222222222222222222222','+33601020304','+33102030405',4,'',1);
 result := public.route_inbound_call('AC11111111111111111111111111111111','CA22222222222222222222222222222222','+33601020304','+33102030405',4,'',2);
 assert jsonb_array_length(result->'devices') = 2, 'No-input fallback reaches the whole line';
 update public.call_reservations set status='released',expires_at=now();
 -- Suspension after the menu was played must immediately prevent new routing.
 result := public.begin_inbound_call('AC11111111111111111111111111111111','CA33333333333333333333333333333333','+33601020304','+33102030405',4);
 select updated_at into version from public.memberships where organization_id=org and user_id=member;
 perform public.admin_update_member(org,actor,member,'Member','member','suspended',version);
 result := public.route_inbound_call('AC11111111111111111111111111111111','CA33333333333333333333333333333333','+33601020304','+33102030405',4,'1',1);
 assert jsonb_array_length(result->'devices') = 0, 'Suspended member cannot ring';
 assert exists(select 1 from public.line_assignments where user_id=member and status='active'), 'Suspension retains assignment';
 select updated_at into version from public.memberships where organization_id=org and user_id=member;
 perform public.admin_update_member(org,actor,member,'Member','member','revoked',version);
 assert not exists(select 1 from public.line_assignments where user_id=member and status='active'), 'Revocation removes assignments';
 -- Hangup fallback and terminal retries never create another call.
 update public.lines set ivr_config = jsonb_set(cfg,'{fallback}','"hangup"') where id=line;
 result := public.begin_inbound_call('AC11111111111111111111111111111111','CA44444444444444444444444444444444','+33601020304','+33102030405',4);
 result := public.route_inbound_call('AC11111111111111111111111111111111','CA44444444444444444444444444444444','+33601020304','+33102030405',4,'',1);
 result := public.route_inbound_call('AC11111111111111111111111111111111','CA44444444444444444444444444444444','+33601020304','+33102030405',4,'',2);
 assert result->>'hangup' = 'true', 'Hangup fallback';
 assert (select result_code from public.calls where id=(result->>'callId')::uuid) = 'ivr_no_selection', 'Hangup recorded as missed';
 assert (select count(*) from public.audit_events where organization_id=org and action in ('member.update','ivr.update')) = 3, 'Administrative actions audited';
 -- Disabling IVR keeps the pre-existing direct-call behavior. Retries respect the cap.
 update public.lines set ivr_config=jsonb_set(cfg,'{enabled}','false') where id=line;
 insert into public.devices(organization_id,user_id,platform,label,voice_identity,voice_registered_at,last_active_at)
 values(org,actor,'web','Second browser','web_admin_second',now(),now());
 result := public.begin_inbound_call('AC11111111111111111111111111111111','CA55555555555555555555555555555555','+33601020304','+33102030405',1);
 assert not (result ? 'ivr') and jsonb_array_length(result->'devices') = 1, 'Disabled IVR routes directly with device cap';
 result := public.begin_inbound_call('AC11111111111111111111111111111111','CA55555555555555555555555555555555','+33601020304','+33102030405',1);
 assert jsonb_array_length(result->'devices') = 1, 'Retry still respects device cap';

end; $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002';
set local role authenticated;
do $$ begin
  assert (select count(*) from public.lines) = 0, 'Revoked member cannot read lines through RLS';
  assert (select count(*) from public.calls) = 0, 'Revoked member cannot read call history through RLS';
  assert (select count(*) from public.line_assignments) = 0, 'Revoked member cannot read assignments through RLS';
end; $$;
reset role;
select '1..1' as plan;
select 'ok 1 - Administration and IVR assertions passed' as result;
rollback;
