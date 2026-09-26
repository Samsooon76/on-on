begin;
insert into auth.users(id,email) values
('00000000-0000-4000-8000-000000000001','transcript-user@test.invalid'),
('00000000-0000-4000-8000-000000000002','transcript-outsider@test.invalid');
insert into public.organizations(id,name) values ('10000000-0000-4000-8000-000000000001','Transcription test');
insert into public.memberships(organization_id,user_id,role) values ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','member');
insert into public.lines(id,organization_id,phone_number,voice_enabled) values ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','+33102030405',true);
insert into public.line_assignments(organization_id,line_id,user_id,can_voice) values ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',true);
insert into public.calls(id,organization_id,line_id,remote_number,direction,status) values ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','+33601020304','outbound','answered');
insert into public.call_transcriptions(call_id,provider_call_sid) values ('30000000-0000-4000-8000-000000000001','CA11111111111111111111111111111111');
update public.call_transcriptions set recording_sid='RE11111111111111111111111111111111', recording_status='ready', recording_duration_seconds=12;
do $$ begin
  assert not has_table_privilege('anon','public.call_transcriptions','select'), 'No anonymous transcript access';
  assert not has_table_privilege('authenticated','public.call_transcriptions','insert'), 'Only server writes text';
  assert not has_table_privilege('authenticated','public.call_transcriptions','update'), 'Clients cannot forge partials';
  begin
    insert into public.call_transcriptions(call_id,provider_call_sid) values ('30000000-0000-4000-8000-000000000001','CA22222222222222222222222222222222');
    raise exception 'Duplicate stream started';
  exception when unique_violation then null; end;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
do $$ begin
  assert (select count(*) from public.call_transcriptions) = 1, 'Assigned user reads transcript';
  assert (select recording_duration_seconds from public.call_transcriptions limit 1) = 12, 'Recording metadata follows call access';
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
do $$ begin assert (select count(*) from public.call_transcriptions) = 0, 'Other user cannot read'; end $$;
reset role;
update public.line_assignments set can_voice = false where user_id='00000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
do $$ begin assert (select count(*) from public.call_transcriptions) = 0, 'Revoked voice permission revokes transcript'; end $$;
reset role;
delete from public.calls where id='30000000-0000-4000-8000-000000000001';
do $$ begin assert (select count(*) from public.call_transcriptions) = 0, 'Call deletion removes saved text'; end $$;
select 'Transcription: RLS, revocation, server-only writes, unique start and cascade verified.' as result;
rollback;
