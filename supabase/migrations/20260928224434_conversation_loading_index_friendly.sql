-- Index-friendly page functions (follow-up to 20260928210000_conversation_loading_performance).
--
-- The first version of these functions joined the page query to the access scope, or filtered messages on
-- the organization as well as on the conversation. On a very large line (tens of thousands of conversations,
-- a thread of thousands of messages) Postgres then read the whole line or thread instead of one page.
-- Same signatures and results; CREATE OR REPLACE keeps the grants. Safe to apply whichever version of the
-- first migration is in place, and the API works with or without this one.

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
