create or replace function private.hold_uncertain_sms_idempotency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.operation = 'send_message' then
    new.expires_at := 'infinity'::timestamptz;
  end if;
  return new;
end;
$$;

create trigger idempotency_requests_hold_uncertain_sms
  before insert on public.idempotency_requests
  for each row execute function private.hold_uncertain_sms_idempotency();

create or replace function private.expire_confirmed_sms_idempotency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.direction = 'outbound'
     and (new.provider_message_sid is not null or new.status in ('failed', 'undelivered'))
     and (tg_op = 'INSERT'
       or old.provider_message_sid is distinct from new.provider_message_sid
       or old.status is distinct from new.status) then
    update public.idempotency_requests
       set expires_at = now() + interval '24 hours'
     where organization_id = new.organization_id
       and operation = 'send_message'
       and response_body ->> 'messageId' = new.id::text
       and expires_at = 'infinity'::timestamptz;
  end if;
  return new;
end;
$$;

create trigger messages_expire_confirmed_sms_idempotency
  after insert or update of status, provider_message_sid on public.messages
  for each row execute function private.expire_confirmed_sms_idempotency();

update public.idempotency_requests request
   set expires_at = 'infinity'::timestamptz
 where request.operation = 'send_message'
   and exists (
     select 1 from public.messages message
      where message.organization_id = request.organization_id
        and message.id::text = request.response_body ->> 'messageId'
        and message.direction = 'outbound'
        and message.status in ('submitting', 'unknown')
        and message.provider_message_sid is null
   );

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
    from public.idempotency_requests request
    join public.messages message
      on message.organization_id = request.organization_id
     and message.id::text = request.response_body ->> 'messageId'
    join public.conversations conversation
      on conversation.organization_id = message.organization_id
     and conversation.id = message.conversation_id
    join public.lines line
      on line.organization_id = conversation.organization_id
     and line.id = conversation.line_id
    join public.memberships membership
      on membership.organization_id = message.organization_id
     and membership.user_id = v_user_id
     and membership.status = 'active'
    join public.line_assignments assignment
      on assignment.organization_id = line.organization_id
     and assignment.line_id = line.id
     and assignment.user_id = v_user_id
     and assignment.status = 'active'
     and assignment.can_sms
   where request.organization_id = message.organization_id
     and request.actor_user_id = v_user_id
     and request.operation = 'send_message'
     and request.expires_at > now()
     and message.direction = 'outbound'
     and message.status in ('submitting', 'unknown')
     and message.provider_message_sid is null
     and line.status = 'active'
     and line.sms_enabled
   order by message.created_at asc, message.id asc
   limit 20;
end;
$$;

revoke all on function public.list_pending_outbound_messages() from public, anon;
grant execute on function public.list_pending_outbound_messages() to authenticated;
