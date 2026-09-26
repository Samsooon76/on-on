begin;
insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000001','mcp@example.invalid'),('00000000-0000-4000-8000-000000000002','other@example.invalid');
insert into public.organizations(id,name,settings) values('10000000-0000-4000-8000-000000000001','MCP org','{"sms":{"allowedDestinationPrefixes":["+33"]}}'),('10000000-0000-4000-8000-000000000002','Other org','{}');
insert into public.memberships(organization_id,user_id,role) values('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','member'),('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','member');
insert into public.lines(id,organization_id,phone_number,twilio_account_sid,voice_enabled,sms_enabled) values
('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','+33102030405','AC11111111111111111111111111111111',true,true),
('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','+33102030406','AC11111111111111111111111111111111',true,true);
insert into public.line_assignments(organization_id,line_id,user_id,can_voice,can_sms) values
('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',true,true),
('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',true,true);
insert into public.contacts(organization_id,display_name) values('10000000-0000-4000-8000-000000000001','Visible'),('10000000-0000-4000-8000-000000000002','Hidden');

-- Exercise service-only actions on real PostgreSQL, including replay and expiry.
do $$
declare u uuid:='00000000-0000-4000-8000-000000000001'; org uuid:='10000000-0000-4000-8000-000000000001'; line uuid:='20000000-0000-4000-8000-000000000001'; g public.mcp_grants; d public.mcp_sms_drafts; c uuid; result jsonb; original_event jsonb;
begin
 assert not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and has_function_privilege('onoff_mcp',p.oid,'execute')), 'No public security-definer function is callable by MCP';
 assert not pg_has_role('onoff_mcp','authenticated','member'), 'MCP role must not inherit user privileges';
 assert not has_function_privilege('onoff_mcp','public.prepare_outbound_message(uuid,uuid,text,text,text,text)','execute'), 'No direct SMS preparation';
 assert not has_function_privilege('onoff_mcp','public.mcp_decide_sms(uuid,uuid,boolean)','execute'), 'Model cannot approve drafts';
 assert not has_function_privilege('onoff_mcp','public.issue_call_intent(uuid,uuid,uuid,text,text,text,integer)','execute'), 'No direct calls';
 assert not has_function_privilege('onoff_mcp','public.admin_snapshot(uuid,uuid)','execute'), 'No administration';
 assert not has_table_privilege('onoff_mcp','public.contacts','insert'), 'No direct contact writes';
 assert not has_column_privilege('onoff_mcp','public.messages','provider_message_sid','select'), 'Provider identifiers remain private';
 assert not has_table_privilege('onoff_mcp','public.mcp_sms_drafts','update'), 'No forged approval';
 assert not has_table_privilege('onoff_mcp','realtime.messages','select'), 'No unscoped Realtime subscription';
 g:=public.mcp_create_grant(u,'test-client','Test assistant',org,array[line],array['contacts:read','messages:read','calls:read'],'https://api.example.test/mcp');
 begin perform public.mcp_write_contact(u,g.id,gen_random_uuid(),'{"displayName":"Forbidden","phones":[]}'); raise exception 'Read-only contact mutation'; exception when insufficient_privilege then null; end;
 begin perform public.mcp_create_sms_draft(u,g.id,gen_random_uuid(),line,'+33601020304','No'); raise exception 'Read-only SMS'; exception when insufficient_privilege then null; end;
 g:=public.mcp_create_grant(u,'test-client','Test assistant',org,array[line],array['contacts:read','contacts:write','messages:read','messages:send','calls:read','calls:prepare'],'https://api.example.test/mcp');
 c:=public.mcp_write_contact(u,g.id,'50000000-0000-4000-8000-000000000001','{"displayName":"Created once","phones":[]}');
 assert public.mcp_write_contact(u,g.id,'50000000-0000-4000-8000-000000000001','{"displayName":"Created once","phones":[]}')=c, 'Contact replay is stable';
 begin perform public.mcp_write_contact(u,g.id,'50000000-0000-4000-8000-000000000001','{"displayName":"Changed","phones":[]}'); raise exception 'Changed replay'; exception when invalid_parameter_value then null; end;
 begin perform public.mcp_write_contact(u,g.id,gen_random_uuid(),jsonb_build_object('id',c,'displayName','Stale','version',99,'phones','[]'::jsonb)); raise exception 'Stale contact update'; exception when serialization_failure then null; end;
 perform public.mcp_write_contact(u,g.id,'50000000-0000-4000-8000-000000000003',jsonb_build_object('id',c,'displayName','Updated once','version',1,'phones','[]'::jsonb));
 perform public.mcp_write_contact(u,g.id,'50000000-0000-4000-8000-000000000003',jsonb_build_object('id',c,'displayName','Updated once','version',1,'phones','[]'::jsonb));
 assert (select version from public.contacts where id=c)=2, 'Update replay does not increment version twice';
 begin perform public.mcp_write_contact(u,g.id,gen_random_uuid(),jsonb_build_object('id',(select id from public.contacts where display_name='Hidden'),'displayName','Foreign','version',1,'phones','[]'::jsonb)); raise exception 'Cross-tenant update'; exception when no_data_found then null; end;
 begin perform public.mcp_create_sms_draft(u,g.id,gen_random_uuid(),'20000000-0000-4000-8000-000000000002','+33601020304','Hidden line'); raise exception 'Unselected line'; exception when insufficient_privilege then null; end;
 d:=public.mcp_create_sms_draft(u,g.id,'50000000-0000-4000-8000-000000000002',line,'+33601020304','Confirm appointment');
 assert (public.mcp_create_sms_draft(u,g.id,'50000000-0000-4000-8000-000000000002',line,'+33601020304','Confirm appointment')).id=d.id, 'Draft replay is stable';
 begin perform public.mcp_create_sms_draft(u,g.id,'50000000-0000-4000-8000-000000000002',line,'+33601020304','Changed'); raise exception 'Changed draft'; exception when invalid_parameter_value then null; end;
 begin perform public.mcp_prepare_sms(u,g.id,d.id,repeat('a',64)); raise exception 'Sent without approval'; exception when insufficient_privilege then null; end;
 begin perform public.mcp_decide_sms('00000000-0000-4000-8000-000000000002',d.id,true); raise exception 'Foreign approval'; exception when no_data_found then null; end;
 perform public.mcp_decide_sms(u,d.id,true);
 result:=public.mcp_prepare_sms(u,g.id,d.id,repeat('a',64));
 assert result->>'messageId' is not null, 'Approved draft creates message';
 assert (public.mcp_prepare_sms(u,g.id,d.id,repeat('a',64))->>'replayed')::boolean, 'Retry never sends again';
 delete from public.idempotency_requests where idempotency_key='mcp:'||d.id::text;
 assert public.mcp_prepare_sms(u,g.id,d.id,repeat('a',64))->>'messageId'=result->>'messageId', 'Replay after API idempotency retention uses permanent message link';
 assert (select count(*) from public.messages where direction='outbound')=1, 'Exactly one prepared message';
 d:=public.mcp_create_sms_draft(u,g.id,gen_random_uuid(),line,'+33601020304','Expired');
 perform public.mcp_decide_sms(u,d.id,true);
 update public.mcp_sms_drafts set expires_at=now()-interval '1 second' where id=d.id;
 begin perform public.mcp_prepare_sms(u,g.id,d.id,repeat('b',64)); raise exception 'Expired approval'; exception when object_not_in_prerequisite_state then null; end;
 d:=public.mcp_create_sms_draft(u,g.id,gen_random_uuid(),line,'+33601020304','Rejected');
 perform public.mcp_decide_sms(u,d.id,false);
 begin perform public.mcp_decide_sms(u,d.id,true); raise exception 'Rejected draft approved'; exception when object_not_in_prerequisite_state then null; end;
 original_event:=jsonb_build_object('user_id',u,'authentication_method','password','claims',jsonb_build_object('sub',u,'role','authenticated','aud','authenticated'));
 assert public.onoff_mcp_access_token_hook(original_event)=original_event, 'Normal login unchanged';
 original_event:=jsonb_build_object('user_id',u,'authentication_method','oauth_provider/authorization_code','claims',jsonb_build_object('sub',u,'client_id','test-client','session_id','60000000-0000-4000-8000-000000000001','role','authenticated','aud','authenticated'));
 result:=public.onoff_mcp_access_token_hook(original_event);
 assert result#>>'{claims,role}'='onoff_mcp' and result#>>'{claims,aud}'=g.resource_url and result#>>'{claims,mcp_grant_id}'=g.id::text, 'OAuth token is bound to role, resource and grant';
 assert public.onoff_mcp_access_token_hook(jsonb_set(original_event,'{authentication_method}','"token_refresh"'))->'claims'->>'mcp_grant_id'=g.id::text, 'Fresh hook input without previous custom claims refreshes correctly';
 perform set_config('test.mcp_claims',(result->'claims')::text,true);
 perform set_config('test.mcp_grant',g.id::text,true);
 update public.line_assignments set can_sms=false where line_id=line and user_id=u;
 begin perform public.mcp_create_sms_draft(u,g.id,gen_random_uuid(),line,'+33601020304','Revoked rights'); raise exception 'Revoked SMS permission'; exception when insufficient_privilege then null; end;
 update public.line_assignments set can_sms=true where line_id=line and user_id=u;
end $$;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims',current_setting('test.mcp_claims'),true);
set local role onoff_mcp;
do $$ begin
 assert (select count(id) from public.organizations)=1, 'Only consented organisation';
 assert (select count(id) from public.lines)=1, 'Only selected line, even when user owns others';
 assert (select count(id) from public.contacts)=2, 'Contacts scoped to consented organisation';
 assert (select count(id) from public.messages)=1, 'Messages accessible through scoped conversation';
 begin perform public.mcp_decide_sms(gen_random_uuid(),gen_random_uuid(),true); raise exception 'Direct approval'; exception when insufficient_privilege then null; end;
 begin insert into public.contacts(organization_id,display_name) values('10000000-0000-4000-8000-000000000001','Bypass'); raise exception 'Direct write'; exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.mcp_grants set permissions=array['calls:read'] where id=current_setting('test.mcp_grant')::uuid;
set local role onoff_mcp;
do $$ begin assert (select count(id) from public.contacts)=0, 'Permission changes apply immediately'; assert (select count(id) from public.messages)=0, 'Reading SMS requires own permission'; end $$;
reset role;
update public.mcp_grants set revoked_at=now() where id=current_setting('test.mcp_grant')::uuid;
set local role onoff_mcp;
do $$ begin assert (select count(id) from public.organizations)=0, 'Revocation effective before JWT expiry'; assert (select count(id) from public.lines)=0, 'Revoked line reads'; end $$;
reset role;
do $$
declare g public.mcp_grants; event jsonb;
begin
 g:=public.mcp_create_grant('00000000-0000-4000-8000-000000000001','test-client','Reconnected','10000000-0000-4000-8000-000000000001','{}',array['contacts:read'],'https://api.example.test/mcp');
 event:=jsonb_build_object('user_id','00000000-0000-4000-8000-000000000001','authentication_method','token_refresh','claims',current_setting('test.mcp_claims')::jsonb);
 begin perform public.onoff_mcp_access_token_hook(event); raise exception 'Old refresh adopted new grant'; exception when insufficient_privilege then null; end;
end $$;
select 'ok - MCP role isolation, OAuth binding, per-tool rights, contact replay, human approval, SMS replay, expiry and revocation';
rollback;
