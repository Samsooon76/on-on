create or replace function public.conversation_unread_status(
  p_line_id uuid,
  p_conversation_ids uuid[]
)
returns table (conversation_id uuid, unread boolean)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    c.id as conversation_id,
    exists (
      select 1
      from public.messages incoming
      left join public.conversation_reads read_state
        on read_state.organization_id = c.organization_id
       and read_state.conversation_id = c.id
       and read_state.user_id = (select auth.uid())
      left join public.messages read_message
        on read_message.organization_id = read_state.organization_id
       and read_message.conversation_id = read_state.conversation_id
       and read_message.id = read_state.last_read_message_id
      where incoming.organization_id = c.organization_id
        and incoming.conversation_id = c.id
        and incoming.direction = 'inbound'
        and (
          read_state.last_read_message_id is null
          or read_message.id is null
          or incoming.created_at > read_message.created_at
          or (incoming.created_at = read_message.created_at and incoming.id > read_message.id)
        )
    ) as unread
  from public.conversations c
  where c.line_id = p_line_id
    and c.id = any(coalesce(p_conversation_ids, array[]::uuid[]));
$function$;

revoke all on function public.conversation_unread_status(uuid, uuid[]) from public, anon;
grant execute on function public.conversation_unread_status(uuid, uuid[]) to authenticated;
