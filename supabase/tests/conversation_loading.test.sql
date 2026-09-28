begin;

-- Users: a1 sms+voice, a2 voice only, a3 member without line, a4 other tenant,
-- a5 suspended member, a6 revoked assignment, a7 sms only.
insert into auth.users(id,email) values
  ('00000000-0000-4000-8000-0000000000a1','a1@test.invalid'),('00000000-0000-4000-8000-0000000000a2','a2@test.invalid'),
  ('00000000-0000-4000-8000-0000000000a3','a3@test.invalid'),('00000000-0000-4000-8000-0000000000a4','a4@test.invalid'),
  ('00000000-0000-4000-8000-0000000000a5','a5@test.invalid'),('00000000-0000-4000-8000-0000000000a6','a6@test.invalid'),
  ('00000000-0000-4000-8000-0000000000a7','a7@test.invalid');
insert into public.organizations(id,name) values ('10000000-0000-4000-8000-000000000001','Org 1'),('10000000-0000-4000-8000-000000000002','Org 2');
insert into public.memberships(organization_id,user_id,role,status) values
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','member','active'),
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2','member','active'),
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a3','member','active'),
  ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000000a4','member','active'),
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a5','member','suspended'),
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a6','member','active'),
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a7','member','active');
insert into public.lines(id,organization_id,phone_number,voice_enabled,sms_enabled) values
  ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','+33102030405',true,true),
  ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','+33102030406',true,true);
insert into public.line_assignments(organization_id,line_id,user_id,can_voice,can_sms,status) values
  ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1',true,true,'active'),
  ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a2',true,false,'active'),
  ('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000000a4',true,true,'active'),
  ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a5',true,true,'active'),
  ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a6',true,true,'revoked'),
  ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a7',false,true,'active');

-- Conversations of line 1. c3 has no message, c5 only holds the pending-send fixtures below
-- (no last_message_at, so it stays out of the inbox); d1 belongs to another tenant.
insert into public.conversations(id,organization_id,line_id,remote_number,last_message_at) values
  ('30000000-0000-4000-8000-0000000000c1','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','+33600000001','2026-09-28 10:00:00+00'),
  ('30000000-0000-4000-8000-0000000000c2','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','+33600000002','2026-09-28 08:30:00+00'),
  ('30000000-0000-4000-8000-0000000000c3','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','+33600000003',null),
  ('30000000-0000-4000-8000-0000000000c4','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','+33600000004','2026-09-28 09:45:00+00'),
  ('30000000-0000-4000-8000-0000000000c5','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','+33600000005',null),
  ('30000000-0000-4000-8000-0000000000c6','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','+33600000006','2026-09-28 07:00:00+00'),
  ('30000000-0000-4000-8000-0000000000c7','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','+33600000007','2026-09-28 07:00:00+00'),
  ('30000000-0000-4000-8000-0000000000d1','10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','+33600000001','2026-09-28 11:00:00+00');
insert into public.messages(id,organization_id,conversation_id,direction,body,status,created_at,provider_message_sid) values
  ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-0000000000c1','inbound','c1 first','received','2026-09-28 09:00:00+00',null),
  ('40000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-0000000000c1','outbound','c1 reply','delivered','2026-09-28 09:30:00+00','SM00000000000000000000000000000002'),
  ('40000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-0000000000c1','inbound','c1 latest','received','2026-09-28 10:00:00+00',null),
  ('40000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-0000000000c2','inbound','c2 first','received','2026-09-28 08:00:00+00',null),
  ('40000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-0000000000c2','outbound','c2 reply','delivered','2026-09-28 08:30:00+00','SM00000000000000000000000000000005'),
  ('40000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-0000000000c4','inbound','c4 only','received','2026-09-28 09:45:00+00',null),
  ('40000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-0000000000c6','inbound','c6 only','received','2026-09-28 07:00:00+00',null),
  ('40000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-0000000000c7','inbound','c7 only','received','2026-09-28 07:00:00+00',null),
  ('40000000-0000-4000-8000-0000000000d1','10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-0000000000d1','inbound','other tenant','received','2026-09-28 11:00:00+00',null);
-- a1 has read c1 up to its first message (a newer inbound one exists => unread), c2 and c6 fully;
-- c4 and c7 never.
insert into public.conversation_reads(organization_id,conversation_id,user_id,last_read_message_id) values
  ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000a1','40000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-0000000000c2','00000000-0000-4000-8000-0000000000a1','40000000-0000-4000-8000-000000000004'),
  ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-0000000000c6','00000000-0000-4000-8000-0000000000a1','40000000-0000-4000-8000-000000000007');

-- Contacts: Alice is unique for c1; the archived one must not label c2; two active contacts share
-- c4's number; another tenant owns a contact with c1's number.
insert into public.contacts(id,organization_id,display_name,archived_at) values
  ('50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Alice',null),
  ('50000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','Archived',now()),
  ('50000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','Bob',null),
  ('50000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','Bobby',null),
  ('50000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000002','Other tenant',null);
insert into public.contact_phones(organization_id,contact_id,phone_number) values
  ('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','+33600000001'),
  ('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002','+33600000002'),
  ('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000003','+33600000004'),
  ('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000004','+33600000004'),
  ('10000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000005','+33600000001');

-- Calls of line 1; calls 2 and 3 share a timestamp so the id tie-break is exercised.
insert into public.calls(id,organization_id,line_id,direction,remote_number,status,created_at,started_at,duration_seconds) values
  ('60000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','inbound','+33600000001','completed','2026-09-28 10:00:00+00','2026-09-28 10:00:01+00',42),
  ('60000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','outbound','+33600000002','completed','2026-09-28 09:00:00+00',null,null),
  ('60000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','inbound','+33600000009','missed','2026-09-28 09:00:00+00',null,null),
  ('60000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','inbound','+33600000004','missed','2026-09-28 08:00:00+00',null,null),
  ('60000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','inbound','+33600000001','completed','2026-09-28 12:00:00+00',null,null);

-- The previous implementations, kept only to prove the new ones return the same rows.
create function public.legacy_latest_conversation_messages(p_line_id uuid, p_conversation_ids uuid[])
returns table (conversation_id uuid, id uuid, body text, direction text, status text, created_at timestamptz)
language sql stable security invoker set search_path = '' as $function$
  select distinct on (m.conversation_id) m.conversation_id, m.id, m.body, m.direction, m.status, m.created_at
  from public.messages m join public.conversations c on c.organization_id = m.organization_id and c.id = m.conversation_id
  where c.line_id = p_line_id and c.id = any(coalesce(p_conversation_ids, array[]::uuid[]))
  order by m.conversation_id, m.created_at desc, m.id desc;
$function$;
create function public.legacy_list_pending_outbound_messages()
returns table (message_id uuid, organization_id uuid, conversation_id uuid, line_id uuid, destination text, body text, idempotency_key text, status text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := auth.uid();
begin
  return query
  select message.id, message.organization_id, conversation.id, conversation.line_id, conversation.remote_number, message.body, request.idempotency_key, message.status, message.created_at
    from public.idempotency_requests request
    join public.messages message on message.organization_id = request.organization_id and message.id::text = request.response_body ->> 'messageId'
    join public.conversations conversation on conversation.organization_id = message.organization_id and conversation.id = message.conversation_id
    join public.lines line on line.organization_id = conversation.organization_id and line.id = conversation.line_id
    join public.memberships membership on membership.organization_id = message.organization_id and membership.user_id = v_user_id and membership.status = 'active'
    join public.line_assignments assignment on assignment.organization_id = line.organization_id and assignment.line_id = line.id and assignment.user_id = v_user_id and assignment.status = 'active' and assignment.can_sms
   where request.organization_id = message.organization_id and request.actor_user_id = v_user_id and request.operation = 'send_message' and request.expires_at > now()
     and message.direction = 'outbound' and message.status in ('submitting', 'unknown') and message.provider_message_sid is null and line.status = 'active' and line.sms_enabled
   order by message.created_at asc, message.id asc limit 20;
end; $$;

-- Pending SMS (all in c5): two uncertain sends by a1, a confirmed one, an expired request,
-- a send by a3, plus a foreign tenant. Requests with a malformed or missing id must not raise.
insert into public.messages(id,organization_id,conversation_id,direction,body,status,created_at,provider_message_sid) values
  ('40000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-0000000000c5','outbound','uncertain 1','submitting','2026-09-28 11:00:00+00',null),
  ('40000000-0000-4000-8000-000000000012','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-0000000000c5','outbound','uncertain 2','unknown','2026-09-28 11:05:00+00',null),
  ('40000000-0000-4000-8000-000000000013','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-0000000000c5','outbound','confirmed','sent','2026-09-28 11:10:00+00','SM00000000000000000000000000000013'),
  ('40000000-0000-4000-8000-000000000014','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-0000000000c5','outbound','expired request','submitting','2026-09-28 11:15:00+00',null),
  ('40000000-0000-4000-8000-000000000015','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-0000000000c5','outbound','sent by someone else','submitting','2026-09-28 11:20:00+00',null),
  ('40000000-0000-4000-8000-000000000016','10000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-0000000000d1','outbound','other tenant','submitting','2026-09-28 11:25:00+00',null);
insert into public.idempotency_requests(organization_id,actor_user_id,operation,idempotency_key,request_hash,status,expires_at,response_body) values
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','send_message','key-1','h','started','infinity','{"messageId":"40000000-0000-4000-8000-000000000011"}'),
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','send_message','key-2','h','started',now()+interval '1 hour','{"messageId":"40000000-0000-4000-8000-000000000012"}'),
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','send_message','key-3','h','completed',now()+interval '1 hour','{"messageId":"40000000-0000-4000-8000-000000000013"}'),
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','send_message','key-4','h','started',now()-interval '1 hour','{"messageId":"40000000-0000-4000-8000-000000000014"}'),
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','send_message','key-5','h','started','infinity','{"messageId":"not-a-uuid"}'),
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1','send_message','key-6','h','started','infinity','{}'),
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a3','send_message','key-7','h','started','infinity','{"messageId":"40000000-0000-4000-8000-000000000015"}'),
  ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000000a4','send_message','key-8','h','started','infinity','{"messageId":"40000000-0000-4000-8000-000000000016"}');
-- A trigger holds every new send request at 'infinity' until the provider confirms the message;
-- set the states a real history would have reached.
update public.idempotency_requests set expires_at = now() + interval '1 hour' where idempotency_key in ('key-2','key-3');
update public.idempotency_requests set expires_at = now() - interval '1 hour' where idempotency_key = 'key-4';

-- 1. Same rows as before for the two rewritten functions (checked without RLS, as function logic).
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a1',true);
do $$ declare ids uuid[] := array(select id from public.conversations where line_id = '20000000-0000-4000-8000-000000000001'); begin
  assert (select count(*) from public.latest_conversation_messages('20000000-0000-4000-8000-000000000001', ids)) = 6, 'Every conversation that has messages has a latest message';
  assert not exists (
    (select * from public.latest_conversation_messages('20000000-0000-4000-8000-000000000001', ids) except select * from public.legacy_latest_conversation_messages('20000000-0000-4000-8000-000000000001', ids))
    union all
    (select * from public.legacy_latest_conversation_messages('20000000-0000-4000-8000-000000000001', ids) except select * from public.latest_conversation_messages('20000000-0000-4000-8000-000000000001', ids))
  ), 'Latest messages are identical to the previous implementation';
  assert (select id from public.latest_conversation_messages('20000000-0000-4000-8000-000000000001', ids) where conversation_id = '30000000-0000-4000-8000-0000000000c5') = '40000000-0000-4000-8000-000000000015', 'The newest message wins whatever its direction';
  assert (select count(*) from public.latest_conversation_messages('20000000-0000-4000-8000-000000000001', null)) = 0, 'A null id list yields nothing';
  assert (select count(*) from public.latest_conversation_messages('20000000-0000-4000-8000-000000000002', ids)) = 0, 'Conversations of another line are ignored';
end $$;
do $$ begin
  assert (select count(*) from public.list_pending_outbound_messages()) = 2, 'Two uncertain sends are pending for a1';
  assert not exists (
    (select * from public.list_pending_outbound_messages() except select * from public.legacy_list_pending_outbound_messages())
    union all
    (select * from public.legacy_list_pending_outbound_messages() except select * from public.list_pending_outbound_messages())
  ), 'Pending sends are identical to the previous implementation';
  assert (select array_agg(message_id order by created_at) from public.list_pending_outbound_messages()) = array['40000000-0000-4000-8000-000000000011','40000000-0000-4000-8000-000000000012']::uuid[], 'Oldest first; confirmed, expired, foreign and malformed ones are excluded';
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a3',true);
do $$ begin
  assert (select count(*) from public.list_pending_outbound_messages()) = 0, 'A member without the line sees no pending send';
  assert (select count(*) from public.legacy_list_pending_outbound_messages()) = 0, 'Same answer as before for that member';
end $$;

-- 2. Inbox page as a1.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a1',true);
do $$ declare page jsonb; ids uuid[]; begin
  page := public.list_line_conversations('20000000-0000-4000-8000-000000000001', 30);
  assert page is not null, 'a1 can read the inbox';
  assert not (page->>'hasMore')::boolean, 'One page holds everything';
  assert jsonb_array_length(page->'items') = 5, 'Conversations without a last message (c3, c5) stay out of the inbox';
  assert (page->'items'->0->>'id') = '30000000-0000-4000-8000-0000000000c1' and (page->'items'->1->>'id') = '30000000-0000-4000-8000-0000000000c4' and (page->'items'->2->>'id') = '30000000-0000-4000-8000-0000000000c2', 'Newest activity first';
  assert (page->'items'->3->>'id') = '30000000-0000-4000-8000-0000000000c7' and (page->'items'->4->>'id') = '30000000-0000-4000-8000-0000000000c6', 'Equal timestamps fall back to id descending';
  assert (page->'items'->0->'last_message'->>'id') = '40000000-0000-4000-8000-000000000003' and (page->'items'->0->'last_message'->>'body') = 'c1 latest' and (page->'items'->0->'last_message'->>'conversation_id') = '30000000-0000-4000-8000-0000000000c1', 'The latest message is embedded with its conversation id';
  assert (page->'items'->0->>'remote_contact_name') = 'Alice', 'A unique active contact labels the number';
  assert (page->'items'->2->>'remote_contact_name') is null, 'An archived contact does not label the number';
  assert (page->'items'->1->>'remote_contact_name') is null, 'Two contacts on one number stay unlabelled';
  assert not exists (select 1 from jsonb_array_elements(page->'items') item where item->>'remote_contact_name' = 'Other tenant'), 'Contacts of other tenants never leak';
  assert (page->'items'->0->>'unread')::boolean and (page->'items'->1->>'unread')::boolean and not (page->'items'->2->>'unread')::boolean, 'Unread: newer inbound after the marker, never read, fully read';
  assert (page->'items'->3->>'unread')::boolean and not (page->'items'->4->>'unread')::boolean, 'Unread flags follow each conversation marker';
  ids := array(select (item->>'id')::uuid from jsonb_array_elements(page->'items') item);
  assert not exists (
    (select (item->>'id')::uuid, (item->>'unread')::boolean from jsonb_array_elements(page->'items') item except select conversation_id, unread from public.conversation_unread_status('20000000-0000-4000-8000-000000000001', ids))
    union all
    (select conversation_id, unread from public.conversation_unread_status('20000000-0000-4000-8000-000000000001', ids) except select (item->>'id')::uuid, (item->>'unread')::boolean from jsonb_array_elements(page->'items') item)
  ), 'Unread flags are exactly what conversation_unread_status returns';
  assert (page->'items'->0->>'last_message_at') is not null and (page->'items'->0->>'line_id') = '20000000-0000-4000-8000-000000000001' and (page->'items'->0->>'organization_id') = '10000000-0000-4000-8000-000000000001', 'Row identity fields are present';
end $$;
-- Pagination, including two conversations with the same timestamp.
do $$ declare page1 jsonb; page2 jsonb; page3 jsonb; cursor_row jsonb; begin
  page1 := public.list_line_conversations('20000000-0000-4000-8000-000000000001', 2);
  assert (page1->>'hasMore')::boolean and jsonb_array_length(page1->'items') = 2, 'First page is full and announces more';
  cursor_row := page1->'items'->1;
  page2 := public.list_line_conversations('20000000-0000-4000-8000-000000000001', 2, (cursor_row->>'last_message_at')::timestamptz, (cursor_row->>'id')::uuid);
  assert (page2->'items'->0->>'id') = '30000000-0000-4000-8000-0000000000c2' and (page2->'items'->1->>'id') = '30000000-0000-4000-8000-0000000000c7' and (page2->>'hasMore')::boolean, 'Second page continues after the cursor';
  cursor_row := page2->'items'->1;
  page3 := public.list_line_conversations('20000000-0000-4000-8000-000000000001', 2, (cursor_row->>'last_message_at')::timestamptz, (cursor_row->>'id')::uuid);
  assert jsonb_array_length(page3->'items') = 1 and (page3->'items'->0->>'id') = '30000000-0000-4000-8000-0000000000c6' and not (page3->>'hasMore')::boolean, 'The tie is neither skipped nor repeated';
  assert jsonb_array_length(public.list_line_conversations('20000000-0000-4000-8000-000000000001', 0)->'items') = 1, 'A page size below one is raised to one';
  assert jsonb_array_length(public.list_line_conversations('20000000-0000-4000-8000-000000000001', 1000)->'items') = 5, 'A page size above the maximum is capped';
end $$;

-- 3. Call history (voice) and thread pages.
do $$ declare page1 jsonb; page2 jsonb; cursor_row jsonb; begin
  page1 := public.list_line_calls('20000000-0000-4000-8000-000000000001', 2);
  assert page1 is not null and (page1->>'hasMore')::boolean and jsonb_array_length(page1->'items') = 2, 'First call page';
  assert (page1->'items'->0->>'id') = '60000000-0000-4000-8000-000000000001' and (page1->'items'->0->>'remote_contact_name') = 'Alice' and (page1->'items'->0->>'duration_seconds')::int = 42 and (page1->'items'->0->>'direction') = 'inbound', 'Newest call first, labelled and complete';
  assert (page1->'items'->1->>'id') = '60000000-0000-4000-8000-000000000003', 'A tie on created_at is resolved by id descending';
  cursor_row := page1->'items'->1;
  page2 := public.list_line_calls('20000000-0000-4000-8000-000000000001', 2, (cursor_row->>'created_at')::timestamptz, (cursor_row->>'id')::uuid);
  assert (page2->'items'->0->>'id') = '60000000-0000-4000-8000-000000000002' and (page2->'items'->1->>'id') = '60000000-0000-4000-8000-000000000004' and not (page2->>'hasMore')::boolean, 'Second call page';
  assert (page2->'items'->0->>'remote_contact_name') is null and (page2->'items'->1->>'remote_contact_name') is null, 'Archived and ambiguous numbers stay unlabelled';
  assert not exists (select 1 from jsonb_array_elements(page1->'items') item where item->>'id' = '60000000-0000-4000-8000-000000000005'), 'Calls of another tenant never appear';
end $$;
do $$ declare thread jsonb; older jsonb; cursor_row jsonb; begin
  thread := public.conversation_thread('30000000-0000-4000-8000-0000000000c1', 2);
  assert (thread->'conversation'->>'remote_number') = '+33600000001' and (thread->'conversation'->>'line_id') = '20000000-0000-4000-8000-000000000001', 'The conversation header is included';
  assert (thread->'items'->0->>'id') = '40000000-0000-4000-8000-000000000003' and (thread->'items'->1->>'id') = '40000000-0000-4000-8000-000000000002', 'Newest messages first';
  assert (thread->>'hasMore')::boolean, 'Older messages remain';
  cursor_row := thread->'items'->1;
  older := public.conversation_thread('30000000-0000-4000-8000-0000000000c1', 2, (cursor_row->>'created_at')::timestamptz, (cursor_row->>'id')::uuid);
  assert jsonb_array_length(older->'items') = 1 and (older->'items'->0->>'id') = '40000000-0000-4000-8000-000000000001' and not (older->>'hasMore')::boolean, 'The cursor continues the thread';
  assert (public.conversation_thread('30000000-0000-4000-8000-0000000000c3', 30)->'items') = '[]'::jsonb and public.conversation_thread('30000000-0000-4000-8000-0000000000c3', 30) is not null, 'A conversation without messages is an empty page, not a missing one';
  assert public.conversation_thread('30000000-0000-4000-8000-0000000000ff', 30) is null, 'Unknown conversation';
  assert public.conversation_thread('30000000-0000-4000-8000-0000000000d1', 30) is null, 'Conversation of another tenant';
end $$;

-- 4. Read markers.
do $$ begin
  assert public.mark_conversation_read('30000000-0000-4000-8000-0000000000c4', '40000000-0000-4000-8000-000000000006') = 'ok', 'Marking a conversation read succeeds';
  assert (select not (item->>'unread')::boolean from jsonb_array_elements(public.list_line_conversations('20000000-0000-4000-8000-000000000001', 30)->'items') item where item->>'id' = '30000000-0000-4000-8000-0000000000c4'), 'The unread flag clears';
  assert public.mark_conversation_read('30000000-0000-4000-8000-0000000000c4', '40000000-0000-4000-8000-000000000006') = 'ok', 'Marking twice is idempotent';
  assert public.mark_conversation_read('30000000-0000-4000-8000-0000000000c4', '40000000-0000-4000-8000-000000000001') = 'invalid_message', 'A message of another conversation is refused';
  assert public.mark_conversation_read('30000000-0000-4000-8000-0000000000c4', '40000000-0000-4000-8000-0000000000d1') = 'invalid_message', 'A message of another tenant is refused';
  assert public.mark_conversation_read('30000000-0000-4000-8000-0000000000ff', null) = 'not_found', 'Unknown conversation';
  assert public.mark_conversation_read('30000000-0000-4000-8000-0000000000d1', null) = 'not_found', 'Conversation of another tenant';
  assert public.mark_conversation_read('30000000-0000-4000-8000-0000000000c1', null) = 'ok', 'A null marker is accepted';
  assert (select (item->>'unread')::boolean from jsonb_array_elements(public.list_line_conversations('20000000-0000-4000-8000-000000000001', 30)->'items') item where item->>'id' = '30000000-0000-4000-8000-0000000000c1'), 'Without a marker inbound messages are unread again';
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.conversation_reads where conversation_id = '30000000-0000-4000-8000-0000000000c4' and user_id = '00000000-0000-4000-8000-0000000000a1') = 1, 'One read row per user and conversation';
  assert (select count(*) from public.conversation_reads where user_id <> '00000000-0000-4000-8000-0000000000a1') = 0, 'Only the caller read state is written';
end $$;

-- 5. Access matrix: users without the right get NULL, never an empty page.
do $$ declare u text; sms boolean; voice boolean; begin
  for u, sms, voice in values
    ('00000000-0000-4000-8000-0000000000a1', true, true), ('00000000-0000-4000-8000-0000000000a2', false, true),
    ('00000000-0000-4000-8000-0000000000a3', false, false), ('00000000-0000-4000-8000-0000000000a4', false, false),
    ('00000000-0000-4000-8000-0000000000a5', false, false), ('00000000-0000-4000-8000-0000000000a6', false, false),
    ('00000000-0000-4000-8000-0000000000a7', true, false)
  loop
    perform set_config('request.jwt.claim.sub', u, true);
    -- Row level security does not apply to the table owner: only the function's own rules remain.
    assert (select count(*) from public.assigned_line_scope('20000000-0000-4000-8000-000000000001', 'sms')) = (case when sms then 1 else 0 end), 'Explicit rules alone, sms, for ' || u;
    assert (select count(*) from public.assigned_line_scope('20000000-0000-4000-8000-000000000001', 'voice')) = (case when voice then 1 else 0 end), 'Explicit rules alone, voice, for ' || u;
    assert (public.list_line_conversations('20000000-0000-4000-8000-000000000001', 30) is not null) = sms, 'Explicit rules alone, inbox, for ' || u;
    assert (public.list_line_calls('20000000-0000-4000-8000-000000000001', 30) is not null) = voice, 'Explicit rules alone, calls, for ' || u;
    set local role authenticated;
    assert (public.list_line_conversations('20000000-0000-4000-8000-000000000001', 30) is not null) = sms, 'Inbox access for ' || u;
    assert (public.conversation_thread('30000000-0000-4000-8000-0000000000c1', 30) is not null) = sms, 'Thread access for ' || u;
    assert (public.mark_conversation_read('30000000-0000-4000-8000-0000000000c1', null) = 'ok') = sms, 'Read marker access for ' || u;
    assert (public.list_line_calls('20000000-0000-4000-8000-000000000001', 30) is not null) = voice, 'Call history access for ' || u;
    assert (select count(*) from public.assigned_line_scope('20000000-0000-4000-8000-000000000001', 'sms')) = (case when sms then 1 else 0 end), 'Scope sms for ' || u;
    assert (select count(*) from public.assigned_line_scope('20000000-0000-4000-8000-000000000001', 'voice')) = (case when voice then 1 else 0 end), 'Scope voice for ' || u;
    assert (select count(*) from public.assigned_line_scope('20000000-0000-4000-8000-000000000001', 'other')) = 0, 'Unknown capability grants nothing for ' || u;
    reset role;
  end loop;
end $$;
-- Anonymous API keys cannot call the new functions; signed-in users can.
do $$ begin
  assert not has_function_privilege('anon','public.list_line_conversations(uuid,integer,timestamptz,uuid)','execute'), 'anon: inbox';
  assert not has_function_privilege('anon','public.list_line_calls(uuid,integer,timestamptz,uuid)','execute'), 'anon: calls';
  assert not has_function_privilege('anon','public.conversation_thread(uuid,integer,timestamptz,uuid)','execute'), 'anon: thread';
  assert not has_function_privilege('anon','public.mark_conversation_read(uuid,uuid)','execute'), 'anon: read marker';
  assert not has_function_privilege('anon','public.assigned_line_scope(uuid,text)','execute'), 'anon: scope';
  assert not has_function_privilege('anon','public.unique_contact_names(uuid,text[])','execute'), 'anon: contact names';
  assert has_function_privilege('authenticated','public.list_line_conversations(uuid,integer,timestamptz,uuid)','execute'), 'authenticated: inbox';
  assert has_function_privilege('authenticated','public.mark_conversation_read(uuid,uuid)','execute'), 'authenticated: read marker';
end $$;
-- No identity at all: nothing is readable and nothing is written.
select set_config('request.jwt.claim.sub','',true);
set local role authenticated;
do $$ begin
  assert public.list_line_conversations('20000000-0000-4000-8000-000000000001', 30) is null, 'No identity, no inbox';
  assert public.mark_conversation_read('30000000-0000-4000-8000-0000000000c1', null) = 'not_found', 'No identity, no read marker';
end $$;
reset role;

select 'Conversation loading: rewritten functions match the previous ones, one-call screens honour membership, assignment, capability and tenant boundaries, pagination handles ties, read markers stay per user.' as result;
rollback;
