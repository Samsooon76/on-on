begin;

create extension if not exists pgtap with schema extensions;
select plan(21);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'assignment-admin-a@example.test', '', now(), '{}'::jsonb, '{}'::jsonb),
  ('00000000-0000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'assignment-member-a@example.test', '', now(), '{}'::jsonb, '{}'::jsonb),
  ('00000000-0000-4000-8000-00000000000c', 'authenticated', 'authenticated', 'assignment-target-a@example.test', '', now(), '{}'::jsonb, '{}'::jsonb),
  ('00000000-0000-4000-8000-00000000000d', 'authenticated', 'authenticated', 'assignment-admin-b@example.test', '', now(), '{}'::jsonb, '{}'::jsonb);

insert into public.organizations (id, name) values
  ('10000000-0000-4000-8000-00000000000a', 'Assignment Test A'),
  ('10000000-0000-4000-8000-00000000000b', 'Assignment Test B');

insert into public.memberships (organization_id, user_id, role) values
  ('10000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a', 'admin'),
  ('10000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', 'member'),
  ('10000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000c', 'member'),
  ('10000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000d', 'admin');

insert into public.lines (id, organization_id, phone_number, voice_enabled, sms_enabled) values
  ('20000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-00000000000a', '+33100000001', true, true),
  ('20000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-00000000000b', '+33100000002', true, true),
  ('20000000-0000-4000-8000-00000000000c', '10000000-0000-4000-8000-00000000000a', '+33100000003', false, true);

set local role service_role;

select ok(
  public.set_line_assignment(
    '10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-00000000000a',
    '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000a', true, true, false
  ) is not null,
  'active admin can assign an active member to a compatible line'
);
select is((select can_voice from public.line_assignments where organization_id = '10000000-0000-4000-8000-00000000000a' and line_id = '20000000-0000-4000-8000-00000000000a' and user_id = '00000000-0000-4000-8000-00000000000c'), true, 'assignment grants requested voice permission');
select is((select can_sms from public.line_assignments where organization_id = '10000000-0000-4000-8000-00000000000a' and line_id = '20000000-0000-4000-8000-00000000000a' and user_id = '00000000-0000-4000-8000-00000000000c'), true, 'assignment grants requested SMS permission');
select is((select count(*) from public.audit_events where organization_id = '10000000-0000-4000-8000-00000000000a' and action = 'line_assignment.upsert'), 1::bigint, 'assignment writes one audit event');

select throws_ok(
  $$select public.set_line_assignment('10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000b', true, true, false)$$,
  '42501', 'Active organization administrator required', 'member cannot assign a line'
);
select throws_ok(
  $$select public.set_line_assignment('10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000d', '00000000-0000-4000-8000-00000000000a', true, true, false)$$,
  '23503', 'Active target membership required', 'admin cannot assign a user from another organization'
);
select throws_ok(
  $$select public.set_line_assignment('10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000a', true, true, false)$$,
  '22023', 'Line does not belong to the organization', 'admin cannot assign a line from another organization'
);

select is(
  public.set_line_assignment(
    '10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-00000000000a',
    '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000a', true, false, false
  ),
  (select id from public.line_assignments where organization_id = '10000000-0000-4000-8000-00000000000a' and line_id = '20000000-0000-4000-8000-00000000000a' and user_id = '00000000-0000-4000-8000-00000000000c'),
  'updating an assignment preserves its identity'
);
select is((select can_sms from public.line_assignments where organization_id = '10000000-0000-4000-8000-00000000000a' and line_id = '20000000-0000-4000-8000-00000000000a' and user_id = '00000000-0000-4000-8000-00000000000c'), false, 'updating an assignment changes granted permissions');
select is((select count(*) from public.audit_events where organization_id = '10000000-0000-4000-8000-00000000000a' and action = 'line_assignment.upsert'), 2::bigint, 'assignment update writes an audit event');

select throws_ok(
  $$select public.set_line_assignment('10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000a', true, false, false)$$,
  '22023', 'Requested line capability is unavailable', 'admin cannot grant voice on an SMS-only line'
);
select throws_ok(
  $$select public.set_line_assignment('10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000a', false, false, false)$$,
  '22023', 'An assignment must allow voice or SMS', 'assignment cannot grant no permissions'
);

select ok(
  public.set_line_assignment(
    '10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-00000000000a',
    '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000a', false, false, true
  ) is not null,
  'admin can revoke an assignment'
);
select is((select status from public.line_assignments where organization_id = '10000000-0000-4000-8000-00000000000a' and line_id = '20000000-0000-4000-8000-00000000000a' and user_id = '00000000-0000-4000-8000-00000000000c'), 'revoked', 'revocation preserves the assignment and marks it revoked');
select is((select can_voice from public.line_assignments where organization_id = '10000000-0000-4000-8000-00000000000a' and line_id = '20000000-0000-4000-8000-00000000000a' and user_id = '00000000-0000-4000-8000-00000000000c'), false, 'revocation clears voice permission');
select is((select count(*) from public.audit_events where organization_id = '10000000-0000-4000-8000-00000000000a' and action = 'line_assignment.revoke'), 1::bigint, 'revocation writes an audit event');
select ok(public.set_line_assignment('10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000a', false, false, true) is null, 'repeated revocation is idempotent');
select is((select count(*) from public.audit_events where organization_id = '10000000-0000-4000-8000-00000000000a' and action = 'line_assignment.revoke'), 1::bigint, 'repeated revocation does not duplicate the audit event');

select ok(has_function_privilege('service_role', 'public.set_line_assignment(uuid, uuid, uuid, uuid, boolean, boolean, boolean)', 'EXECUTE'), 'service role can execute the guarded assignment function');
select ok(not has_function_privilege('authenticated', 'public.set_line_assignment(uuid, uuid, uuid, uuid, boolean, boolean, boolean)', 'EXECUTE'), 'authenticated role cannot execute the privileged assignment function');
select ok(not has_function_privilege('anon', 'public.set_line_assignment(uuid, uuid, uuid, uuid, boolean, boolean, boolean)', 'EXECUTE'), 'anonymous role cannot execute the privileged assignment function');

select * from finish();
rollback;
