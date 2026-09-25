begin;

create extension if not exists pgtap with schema extensions;

select plan(9);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'rls-a@example.test', '', now(), '{}'::jsonb, '{}'::jsonb),
  ('00000000-0000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'rls-b@example.test', '', now(), '{}'::jsonb, '{}'::jsonb);

insert into public.organizations (id, name) values
  ('10000000-0000-4000-8000-00000000000a', 'RLS Test A'),
  ('10000000-0000-4000-8000-00000000000b', 'RLS Test B');

insert into public.memberships (organization_id, user_id, role) values
  ('10000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a', 'member'),
  ('10000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000b', 'member');

insert into public.lines (id, organization_id, phone_number, voice_enabled, sms_enabled) values
  ('20000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-00000000000a', '+32200000001', true, true),
  ('20000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-00000000000b', '+32200000002', true, true);

insert into public.line_assignments (organization_id, line_id, user_id, can_voice, can_sms) values
  ('10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a', true, true),
  ('10000000-0000-4000-8000-00000000000b', '20000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000b', true, true);

insert into public.contacts (id, organization_id, display_name) values
  ('30000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-00000000000a', 'Contact A'),
  ('30000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-00000000000b', 'Contact B');

insert into public.calls (id, organization_id, line_id, direction, remote_number) values
  ('40000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-00000000000a', 'outbound', '+32470000001'),
  ('40000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-00000000000b', '20000000-0000-4000-8000-00000000000b', 'outbound', '+32470000002');

insert into public.conversations (id, organization_id, line_id, remote_number) values
  ('50000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-00000000000a', '+32470000001'),
  ('50000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-00000000000b', '20000000-0000-4000-8000-00000000000b', '+32470000002');

insert into public.messages (id, organization_id, conversation_id, direction, body, status) values
  ('60000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-00000000000a', '50000000-0000-4000-8000-00000000000a', 'inbound', 'Hello A', 'received'),
  ('60000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-00000000000b', '50000000-0000-4000-8000-00000000000b', 'inbound', 'Hello B', 'received');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000a', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated","aud":"authenticated"}', true);
set local role authenticated;

select is((select count(*) from public.organizations), 1::bigint, 'member A sees only its organization');
select is((select count(*) from public.memberships), 1::bigint, 'member A sees only its membership');
select is((select count(*) from public.lines), 1::bigint, 'member A sees only its assigned line');
select is((select count(*) from public.contacts), 1::bigint, 'member A sees only its organization contacts');
select is((select count(*) from public.calls), 1::bigint, 'member A sees calls for its assigned line');
select is((select count(*) from public.conversations), 1::bigint, 'member A sees conversations for its assigned line');
select is((select count(*) from public.messages), 1::bigint, 'member A sees messages for its assigned line');
select ok(not has_table_privilege('authenticated', 'public.provider_events', 'SELECT'), 'provider events are not directly readable');
select ok(not has_table_privilege('anon', 'public.contacts', 'SELECT'), 'anonymous users cannot read contacts');

select * from finish();
rollback;
