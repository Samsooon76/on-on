create table public.message_reconciliation_tasks (
  organization_id uuid not null,
  message_id uuid primary key,
  next_attempt_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  manual_review_required boolean not null default false,
  foreign key (organization_id, message_id)
    references public.messages(organization_id, id) on delete cascade
);

create index message_reconciliation_tasks_due_idx
  on public.message_reconciliation_tasks(next_attempt_at, message_id);

alter table public.message_reconciliation_tasks enable row level security;
revoke all on table public.message_reconciliation_tasks from public, anon, authenticated;
grant select on table public.message_reconciliation_tasks to service_role;

create or replace function private.sync_message_reconciliation_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.direction <> 'outbound' then
    return new;
  end if;

  if new.status in ('submitting', 'unknown') then
    insert into public.message_reconciliation_tasks (organization_id, message_id, next_attempt_at)
    values (new.organization_id, new.id, now() + interval '2 minutes')
    on conflict (message_id) do nothing;
  elsif new.status = 'sent' then
    if tg_op = 'INSERT' or old.status <> 'sent' then
      insert into public.message_reconciliation_tasks (organization_id, message_id, next_attempt_at)
      values (new.organization_id, new.id, now() + interval '12 hours')
      on conflict (message_id) do update set next_attempt_at = excluded.next_attempt_at;
    end if;
  else
    delete from public.message_reconciliation_tasks where message_id = new.id;
  end if;

  return new;
end;
$$;

create trigger messages_sync_reconciliation_task
  after insert or update of status on public.messages
  for each row execute function private.sync_message_reconciliation_task();

insert into public.message_reconciliation_tasks (organization_id, message_id, next_attempt_at)
select organization_id, id,
  case when status = 'sent' then created_at + interval '12 hours' else created_at + interval '2 minutes' end
from public.messages
where direction = 'outbound' and status in ('submitting', 'unknown', 'sent')
on conflict (message_id) do nothing;

create or replace function public.update_outbound_message_result(
  p_message_id uuid,
  p_message_sid text,
  p_status text,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message public.messages%rowtype;
  v_new_status text;
begin
  if p_message_id is null or p_status not in ('pending', 'submitting', 'unknown', 'sent', 'delivered', 'undelivered', 'failed')
     or (p_message_sid is not null and p_message_sid !~ '^SM[0-9a-fA-F]{32}$') then
    raise exception 'invalid outbound result' using errcode = '22023';
  end if;
  select * into v_message from public.messages where id = p_message_id and direction = 'outbound' for update;
  if not found then raise exception 'message not found' using errcode = 'P0002'; end if;

  v_new_status := case
    when v_message.status = 'delivered' then 'delivered'
    when v_message.status in ('failed', 'undelivered') and p_status in ('pending', 'submitting', 'unknown', 'sent') then v_message.status
    when v_message.status = 'sent' and p_status in ('pending', 'submitting', 'unknown') then 'sent'
    else p_status
  end;
  update public.messages set provider_message_sid = coalesce(provider_message_sid, p_message_sid),
    status = v_new_status, provider_error_code = coalesce(p_error_code, provider_error_code),
    sent_at = coalesce(sent_at, case when v_new_status in ('sent', 'delivered') then now() end),
    delivered_at = coalesce(delivered_at, case when v_new_status = 'delivered' then now() end)
   where id = p_message_id;
  return pg_catalog.jsonb_build_object('messageId', p_message_id, 'status', v_new_status);
end;
$$;

create or replace function public.apply_message_status(
  p_account_sid text,
  p_message_id uuid,
  p_message_sid text,
  p_status text,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message public.messages%rowtype;
  v_event_id uuid;
  v_new_status text;
begin
  if p_account_sid is null or p_message_id is null or p_message_sid is null or p_message_sid !~ '^SM[0-9a-fA-F]{32}$'
     or p_status not in ('accepted', 'queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed', 'read') then
    raise exception 'invalid message status' using errcode = '22023';
  end if;
  select msg.* into v_message
    from public.messages msg
    join public.conversations c on c.organization_id = msg.organization_id and c.id = msg.conversation_id
    join public.lines l on l.organization_id = c.organization_id and l.id = c.line_id
   where msg.id = p_message_id and msg.direction = 'outbound' and l.twilio_account_sid = p_account_sid
   for update of msg;
  if not found then raise exception 'message not found' using errcode = 'P0002'; end if;
  insert into public.provider_events (provider, provider_account_sid, resource_sid, event_type, dedupe_key)
  values ('twilio', p_account_sid, p_message_sid, 'message.status.' || p_status,
    'message:' || p_account_sid || ':' || p_message_sid || ':' || p_status)
  on conflict (dedupe_key) do nothing returning id into v_event_id;
  if v_event_id is null then return pg_catalog.jsonb_build_object('duplicate', true); end if;
  if v_message.provider_message_sid is not null and v_message.provider_message_sid <> p_message_sid then
    raise exception 'message sid mismatch' using errcode = '22023';
  end if;
  v_new_status := case p_status
    when 'delivered' then 'delivered'
    when 'read' then 'delivered'
    when 'undelivered' then 'undelivered'
    when 'failed' then 'failed'
    when 'sent' then 'sent'
    else 'submitting'
  end;
  if v_message.status = 'delivered' then v_new_status := 'delivered';
  elsif v_message.status in ('failed', 'undelivered') and v_new_status in ('submitting', 'sent') then v_new_status := v_message.status;
  elsif v_message.status = 'sent' and v_new_status = 'submitting' then v_new_status := 'sent';
  end if;
  update public.messages set provider_message_sid = coalesce(provider_message_sid, p_message_sid), status = v_new_status,
    provider_error_code = coalesce(p_error_code, provider_error_code),
    sent_at = coalesce(sent_at, case when v_new_status in ('sent', 'delivered') then now() end),
    delivered_at = coalesce(delivered_at, case when v_new_status = 'delivered' then now() end)
   where id = p_message_id;
  update public.provider_events set outcome = 'applied', applied_at = now() where id = v_event_id;
  return pg_catalog.jsonb_build_object('duplicate', false, 'messageId', p_message_id, 'status', v_new_status);
end;
$$;

create or replace function public.record_message_reconciliation(
  p_message_id uuid,
  p_next_attempt_at timestamptz,
  p_manual_review_required boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_was_manual boolean;
begin
  if p_message_id is null or p_next_attempt_at is null
     or p_next_attempt_at <= now()
     or p_next_attempt_at > now() + interval '24 hours' then
    raise exception 'invalid message reconciliation schedule' using errcode = '22023';
  end if;

  select manual_review_required into v_was_manual
    from public.message_reconciliation_tasks where message_id = p_message_id for update;
  if not found then
    return false;
  end if;

  update public.message_reconciliation_tasks
     set next_attempt_at = p_next_attempt_at,
         attempts = attempts + 1,
         last_attempt_at = now(),
         manual_review_required = manual_review_required or p_manual_review_required
   where message_id = p_message_id;

  return p_manual_review_required and not v_was_manual;
end;
$$;

revoke all on function public.record_message_reconciliation(uuid, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.record_message_reconciliation(uuid, timestamptz, boolean) to service_role;
