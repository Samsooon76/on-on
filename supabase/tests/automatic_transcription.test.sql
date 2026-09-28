begin;
insert into public.organizations(id,name) values ('10000000-0000-4000-8000-000000000009','Automatic transcription test');
set local role service_role;
insert into public.transcription_settings(organization_id) values ('10000000-0000-4000-8000-000000000009');
do $$ begin
  assert (select auto_start = false from public.transcription_settings where organization_id = '10000000-0000-4000-8000-000000000009'), 'Disabled by default';
end $$;
update public.transcription_settings set auto_start = true where organization_id = '10000000-0000-4000-8000-000000000009';
reset role;
do $$ begin
  assert (select auto_start from public.transcription_settings where organization_id = '10000000-0000-4000-8000-000000000009'), 'Server can enable';
  assert not has_table_privilege('authenticated','public.transcription_settings','insert'), 'No direct client insert';
  assert not has_table_privilege('authenticated','public.transcription_settings','update'), 'No direct client updates';
  assert not has_table_privilege('anon','public.transcription_settings','select'), 'No public access';
  assert (select relrowsecurity from pg_class where oid = 'public.transcription_settings'::regclass), 'RLS enabled';
end $$;
rollback;
