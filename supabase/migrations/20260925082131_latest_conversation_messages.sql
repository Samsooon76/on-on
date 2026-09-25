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
  select distinct on (m.conversation_id)
    m.conversation_id, m.id, m.body, m.direction, m.status, m.created_at
  from public.messages m
  join public.conversations c
    on c.organization_id = m.organization_id
   and c.id = m.conversation_id
  where c.line_id = p_line_id
    and c.id = any(coalesce(p_conversation_ids, array[]::uuid[]))
  order by m.conversation_id, m.created_at desc, m.id desc;
$function$;

revoke all on function public.latest_conversation_messages(uuid, uuid[]) from public, anon;
grant execute on function public.latest_conversation_messages(uuid, uuid[]) to authenticated;
