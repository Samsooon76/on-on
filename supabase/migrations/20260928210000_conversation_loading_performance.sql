-- Faster conversation loading.
--
-- 1. latest_conversation_messages and list_pending_outbound_messages read far more
--    rows than they return (every message of the listed conversations, and every
--    message of every conversation of the caller's lines). They keep their signature
--    and results, so the API behaves the same before and after this migration.
-- 2. The list/thread/read functions below let the API serve one screen in a single
--    round trip instead of six to eight. They are SECURITY INVOKER: row level
--    security still applies, and each one also checks the caller's active
--    membership and line assignment explicitly and returns NULL when the caller has
--    no access.

-- One correlated lookup per conversation instead of sorting every message.
create or replace function public.latest_conversation_messages(
  p_line_id uuid,
  p_conversation_ids uuid[]
)
returns table (
  conversation_id uuid,
  id uuid,
  body text,
  direction text,
  status text,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select latest.conversation_id, latest.id, latest.body, latest.direction, latest.status, latest.created_at
  from (select distinct wanted.id from unnest(coalesce(p_conversation_ids, array[]::uuid[])) as wanted(id)) wanted
  -- Reach each conversation by its key and each latest message through the (conversation, time) index,
  -- so the cost follows the number of ids asked for, not the size of the line or of a thread.
  cross join lateral (
    select c.id from public.conversations c
    where c.id = wanted.id and c.line_id = p_line_id
  ) c
  cross join lateral (
    select m.conversation_id, m.id, m.body, m.direction, m.status, m.created_at
    from public.messages m
    where m.conversation_id = c.id
    order by m.created_at desc, m.id desc
    limit 1
  ) latest
  order by latest.conversation_id;
$function$;

-- Start from the caller's live send requests (a handful) and reach each message by
-- primary key. The previous join compared message.id::text with a JSON field, which
-- cannot use an index and made the planner read every message of the caller's lines.
create or replace function public.list_pending_outbound_messages()
returns table (
  message_id uuid,
  organization_id uuid,
  conversation_id uuid,
  line_id uuid,
  destination text,
  body text,
  idempotency_key text,
  status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  return query
  select message.id, message.organization_id, conversation.id, conversation.line_id,
         conversation.remote_number, message.body, request.idempotency_key,
         message.status, message.created_at
    from public.memberships membership
    join public.idempotency_requests request
      on request.organization_id = membership.organization_id
     and request.actor_user_id = v_user_id
     and request.operation = 'send_message'
     and request.expires_at > now()
    join public.messages message
      on message.organization_id = request.organization_id
     -- A malformed stored id must not raise: it simply matches no message.
     and message.id = case
       when request.response_body ->> 'messageId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       then (request.response_body ->> 'messageId')::uuid
     end
    join public.conversations conversation
      on conversation.organization_id = message.organization_id
     and conversation.id = message.conversation_id
    join public.lines line
      on line.organization_id = conversation.organization_id
     and line.id = conversation.line_id
    join public.line_assignments assignment
      on assignment.organization_id = line.organization_id
     and assignment.line_id = line.id
     and assignment.user_id = v_user_id
     and assignment.status = 'active'
     and assignment.can_sms
   where membership.user_id = v_user_id
     and membership.status = 'active'
     and message.direction = 'outbound'
     and message.status in ('submitting', 'unknown')
     and message.provider_message_sid is null
     and line.status = 'active'
     and line.sms_enabled
   order by message.created_at asc, message.id asc
   limit 20;
end;
$$;

-- The line (and organization) the caller may use for a capability: an active
-- assignment carrying that right, held by an active member of the organization.
create or replace function public.assigned_line_scope(p_line_id uuid, p_capability text)
returns table (organization_id uuid, line_id uuid)
language sql
stable
security invoker
set search_path = ''
as $function$
  select assignment.organization_id, assignment.line_id
  from public.line_assignments assignment
  join public.memberships membership
    on membership.organization_id = assignment.organization_id
   and membership.user_id = assignment.user_id
   and membership.status = 'active'
  where assignment.line_id = p_line_id
    and assignment.user_id = (select auth.uid())
    and assignment.status = 'active'
    and case p_capability
      when 'sms' then assignment.can_sms
      when 'voice' then assignment.can_voice
      else false
    end;
$function$;

-- A number is labelled only when exactly one active contact owns it.
create or replace function public.unique_contact_names(p_organization_id uuid, p_numbers text[])
returns table (phone_number text, display_name text)
language sql
stable
security invoker
set search_path = ''
as $function$
  select phone.phone_number, min(contact.display_name)
  from public.contact_phones phone
  join public.contacts contact
    on contact.organization_id = phone.organization_id
   and contact.id = phone.contact_id
   and contact.archived_at is null
  where phone.organization_id = p_organization_id
    and phone.phone_number = any(coalesce(p_numbers, array[]::text[]))
  group by phone.phone_number
  having count(distinct contact.id) = 1;
$function$;

-- Inbox page: conversations, latest message, unread flag and contact label at once.
-- Returns NULL when the caller has no SMS access to the line.
create or replace function public.list_line_conversations(
  p_line_id uuid,
  p_limit integer default 30,
  p_cursor_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with params as (
    select least(greatest(coalesce(p_limit, 30), 1), 100) as page_size
  ),
  scope as (
    select * from public.assigned_line_scope(p_line_id, 'sms')
  ),
  fetched as (
    -- Filter on the parameter, not on a join with `scope`: the line then stays an index condition
    -- and only one page is read. `scope` still decides who may read (no scope, no organization, no row).
    select c.id, c.organization_id, c.line_id, c.remote_number, c.last_message_at
    from public.conversations c
    where c.line_id = p_line_id
      and c.organization_id = (select organization_id from scope)
      and c.last_message_at is not null
      and (
        p_cursor_at is null
        or c.last_message_at < p_cursor_at
        or (c.last_message_at = p_cursor_at and c.id < p_cursor_id)
      )
    order by c.last_message_at desc, c.id desc
    limit (select page_size + 1 from params)
  ),
  ranked as (
    select fetched.*, row_number() over (order by fetched.last_message_at desc, fetched.id desc) as rn
    from fetched
  ),
  shown as (
    select ranked.* from ranked where ranked.rn <= (select page_size from params)
  ),
  latest as (
    select * from public.latest_conversation_messages(p_line_id, array(select id from shown))
  ),
  unread as (
    select * from public.conversation_unread_status(p_line_id, array(select id from shown))
  ),
  names as (
    select * from public.unique_contact_names((select organization_id from scope), array(select remote_number from shown))
  )
  select case when not exists (select 1 from scope) then null else jsonb_build_object(
    'hasMore', (select count(*) from ranked) > (select page_size from params),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'organization_id', s.organization_id,
        'line_id', s.line_id,
        'remote_number', s.remote_number,
        'last_message_at', s.last_message_at,
        'remote_contact_name', n.display_name,
        'last_message', case when l.id is null then null else jsonb_build_object(
          'id', l.id, 'conversation_id', l.conversation_id, 'body', l.body,
          'direction', l.direction, 'status', l.status, 'created_at', l.created_at) end,
        'unread', coalesce(u.unread, false)
      ) order by s.rn)
      from shown s
      left join latest l on l.conversation_id = s.id
      left join unread u on u.conversation_id = s.id
      left join names n on n.phone_number = s.remote_number
    ), '[]'::jsonb)
  ) end;
$function$;

-- Call history page with contact labels. Returns NULL without voice access to the line.
create or replace function public.list_line_calls(
  p_line_id uuid,
  p_limit integer default 30,
  p_cursor_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with params as (
    select least(greatest(coalesce(p_limit, 30), 1), 100) as page_size
  ),
  scope as (
    select * from public.assigned_line_scope(p_line_id, 'voice')
  ),
  fetched as (
    select c.id, c.organization_id, c.line_id, c.direction, c.remote_number, c.status,
           c.started_at, c.answered_at, c.ended_at, c.duration_seconds, c.created_at
    from public.calls c
    where c.line_id = p_line_id
      and c.organization_id = (select organization_id from scope)
      and (
        p_cursor_at is null
        or c.created_at < p_cursor_at
        or (c.created_at = p_cursor_at and c.id < p_cursor_id)
      )
    order by c.created_at desc, c.id desc
    limit (select page_size + 1 from params)
  ),
  ranked as (
    select fetched.*, row_number() over (order by fetched.created_at desc, fetched.id desc) as rn
    from fetched
  ),
  shown as (
    select ranked.* from ranked where ranked.rn <= (select page_size from params)
  ),
  names as (
    select * from public.unique_contact_names((select organization_id from scope), array(select remote_number from shown))
  )
  select case when not exists (select 1 from scope) then null else jsonb_build_object(
    'hasMore', (select count(*) from ranked) > (select page_size from params),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'organization_id', s.organization_id,
        'line_id', s.line_id,
        'direction', s.direction,
        'remote_number', s.remote_number,
        'status', s.status,
        'started_at', s.started_at,
        'answered_at', s.answered_at,
        'ended_at', s.ended_at,
        'duration_seconds', s.duration_seconds,
        'created_at', s.created_at,
        'remote_contact_name', n.display_name
      ) order by s.rn)
      from shown s
      left join names n on n.phone_number = s.remote_number
    ), '[]'::jsonb)
  ) end;
$function$;

-- One conversation page, newest message first. Returns NULL when the conversation
-- does not exist or the caller has no SMS access to its line.
create or replace function public.conversation_thread(
  p_conversation_id uuid,
  p_limit integer default 30,
  p_cursor_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with params as (
    select least(greatest(coalesce(p_limit, 30), 1), 100) as page_size
  ),
  scope as (
    select c.id, c.organization_id, c.line_id, c.remote_number
    from public.conversations c
    cross join lateral public.assigned_line_scope(c.line_id, 'sms') granted
    where c.id = p_conversation_id
      and granted.organization_id = c.organization_id
  ),
  fetched as (
    select m.id, m.conversation_id, m.direction, m.body, m.status, m.provider_error_code,
           m.created_at, m.sent_at, m.delivered_at
    from public.messages m
    where m.conversation_id = p_conversation_id
      and exists (select 1 from scope)
      and (
        p_cursor_at is null
        or m.created_at < p_cursor_at
        or (m.created_at = p_cursor_at and m.id < p_cursor_id)
      )
    order by m.created_at desc, m.id desc
    limit (select page_size + 1 from params)
  ),
  ranked as (
    select fetched.*, row_number() over (order by fetched.created_at desc, fetched.id desc) as rn
    from fetched
  ),
  shown as (
    select ranked.* from ranked where ranked.rn <= (select page_size from params)
  )
  select case when not exists (select 1 from scope) then null else jsonb_build_object(
    'conversation', (
      select jsonb_build_object('id', scope.id, 'organization_id', scope.organization_id,
                                'line_id', scope.line_id, 'remote_number', scope.remote_number)
      from scope
    ),
    'hasMore', (select count(*) from ranked) > (select page_size from params),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'conversation_id', s.conversation_id,
        'direction', s.direction,
        'body', s.body,
        'status', s.status,
        'provider_error_code', s.provider_error_code,
        'created_at', s.created_at,
        'sent_at', s.sent_at,
        'delivered_at', s.delivered_at
      ) order by s.rn)
      from shown s
    ), '[]'::jsonb)
  ) end;
$function$;

-- Records how far the caller has read a conversation.
-- Returns 'ok', 'not_found' (no such conversation for this caller) or
-- 'invalid_message' (the message belongs to another conversation).
create or replace function public.mark_conversation_read(
  p_conversation_id uuid,
  p_last_read_message_id uuid default null
)
returns text
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_organization_id uuid;
begin
  select c.organization_id into v_organization_id
  from public.conversations c
  cross join lateral public.assigned_line_scope(c.line_id, 'sms') granted
  where c.id = p_conversation_id
    and granted.organization_id = c.organization_id;
  if v_organization_id is null then
    return 'not_found';
  end if;

  if p_last_read_message_id is not null and not exists (
    select 1 from public.messages m
    where m.organization_id = v_organization_id
      and m.conversation_id = p_conversation_id
      and m.id = p_last_read_message_id
  ) then
    return 'invalid_message';
  end if;

  insert into public.conversation_reads (organization_id, conversation_id, user_id, last_read_message_id)
  values (v_organization_id, p_conversation_id, (select auth.uid()), p_last_read_message_id)
  on conflict (conversation_id, user_id)
  do update set last_read_message_id = excluded.last_read_message_id;
  return 'ok';
end;
$function$;

revoke all on function public.assigned_line_scope(uuid, text) from public, anon;
revoke all on function public.unique_contact_names(uuid, text[]) from public, anon;
revoke all on function public.list_line_conversations(uuid, integer, timestamptz, uuid) from public, anon;
revoke all on function public.list_line_calls(uuid, integer, timestamptz, uuid) from public, anon;
revoke all on function public.conversation_thread(uuid, integer, timestamptz, uuid) from public, anon;
revoke all on function public.mark_conversation_read(uuid, uuid) from public, anon;
grant execute on function public.assigned_line_scope(uuid, text) to authenticated;
grant execute on function public.unique_contact_names(uuid, text[]) to authenticated;
grant execute on function public.list_line_conversations(uuid, integer, timestamptz, uuid) to authenticated;
grant execute on function public.list_line_calls(uuid, integer, timestamptz, uuid) to authenticated;
grant execute on function public.conversation_thread(uuid, integer, timestamptz, uuid) to authenticated;
grant execute on function public.mark_conversation_read(uuid, uuid) to authenticated;
