alter table public.provider_events
  add column provider_event_at timestamptz,
  add column provider_sequence_number integer check (provider_sequence_number is null or provider_sequence_number >= 0);

create index provider_events_voice_sequence_idx
  on public.provider_events(provider_account_sid, resource_sid, provider_sequence_number)
  where provider = 'twilio' and event_type like 'voice.status.%';

create or replace function public.apply_call_status(
  p_account_sid text,
  p_call_sid text,
  p_parent_call_sid text,
  p_call_status text,
  p_call_duration integer,
  p_provider_event_at timestamptz,
  p_provider_sequence_number integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_leg public.call_legs%rowtype;
  v_parent_leg public.call_legs%rowtype;
  v_call public.calls%rowtype;
  v_leg_status text;
  v_call_status text;
  v_event_id uuid;
  v_is_root boolean := true;
  v_inbound_child_miss boolean := false;
begin
  if p_account_sid is null or p_call_sid is null or p_call_sid !~ '^CA[0-9a-fA-F]{32}$'
     or (p_parent_call_sid is not null and p_parent_call_sid !~ '^CA[0-9a-fA-F]{32}$')
     or p_call_status not in ('initiated', 'ringing', 'in-progress', 'completed', 'busy', 'no-answer', 'canceled', 'failed')
     or (p_call_duration is not null and p_call_duration < 0)
     or (p_provider_sequence_number is not null and p_provider_sequence_number < 0) then
    raise exception 'invalid voice status payload' using errcode = '22023';
  end if;

  insert into public.provider_events (
    provider, provider_account_sid, resource_sid, event_type, dedupe_key,
    provider_event_at, provider_sequence_number
  )
  values (
    'twilio', p_account_sid, p_call_sid, 'voice.status.' || p_call_status,
    'voice:' || p_account_sid || ':' || p_call_sid || ':' || p_call_status,
    p_provider_event_at, p_provider_sequence_number
  )
  on conflict (dedupe_key) do nothing returning id into v_event_id;
  if v_event_id is null then
    update public.provider_events set
      provider_event_at = coalesce(provider_event_at, p_provider_event_at),
      provider_sequence_number = coalesce(provider_sequence_number, p_provider_sequence_number)
     where dedupe_key = 'voice:' || p_account_sid || ':' || p_call_sid || ':' || p_call_status;
    return pg_catalog.jsonb_build_object('duplicate', true);
  end if;

  if p_parent_call_sid is not null then
    select parent.* into v_parent_leg
      from public.call_legs parent
      join public.calls c on c.organization_id = parent.organization_id and c.id = parent.call_id
      join public.lines l on l.organization_id = c.organization_id and l.id = c.line_id
     where parent.provider_call_sid = p_parent_call_sid and l.twilio_account_sid = p_account_sid
     for update of parent;
    if not found then
      update public.provider_events set outcome = 'ignored', applied_at = now() where id = v_event_id;
      return pg_catalog.jsonb_build_object('duplicate', false, 'ignored', true);
    end if;

    if p_provider_sequence_number is not null and exists (
      select 1 from public.provider_events newer
       where newer.provider = 'twilio'
         and newer.provider_account_sid = p_account_sid
         and newer.resource_sid = p_call_sid
         and newer.event_type like 'voice.status.%'
         and newer.provider_sequence_number > p_provider_sequence_number
    ) then
      update public.provider_events set outcome = 'ignored', applied_at = now() where id = v_event_id;
      return pg_catalog.jsonb_build_object('duplicate', false, 'ignored', true, 'stale', true);
    end if;

    if p_call_sid = p_parent_call_sid then
      v_leg := v_parent_leg;
    else
      insert into public.call_legs (organization_id, call_id, provider_call_sid, parent_call_sid, status, started_at)
      values (v_parent_leg.organization_id, v_parent_leg.call_id, p_call_sid, p_parent_call_sid, 'initiated', now())
      on conflict (provider_call_sid) do nothing;
      select * into v_leg from public.call_legs where provider_call_sid = p_call_sid for update;
      v_is_root := false;
    end if;
  else
    select * into v_leg from public.call_legs where provider_call_sid = p_call_sid for update;
  end if;
  if v_leg.id is null then
    update public.provider_events set outcome = 'ignored', applied_at = now() where id = v_event_id;
    return pg_catalog.jsonb_build_object('duplicate', false, 'ignored', true);
  end if;

  v_leg_status := case p_call_status
    when 'in-progress' then 'answered'
    when 'busy' then 'failed'
    when 'no-answer' then 'failed'
    else p_call_status
  end;
  update public.call_legs set
    status = case when status in ('completed', 'failed', 'canceled') then status else v_leg_status end,
    started_at = coalesce(started_at, case when p_call_status in ('initiated', 'ringing', 'in-progress') then now() end),
    answered_at = coalesce(answered_at, case when p_call_status in ('in-progress', 'completed') then now() end),
    ended_at = coalesce(ended_at, case when p_call_status in ('completed', 'busy', 'no-answer', 'canceled', 'failed') then now() end),
    duration_seconds = coalesce(p_call_duration, duration_seconds)
   where id = v_leg.id;

  select * into v_call from public.calls where organization_id = v_leg.organization_id and id = v_leg.call_id for update;
  v_inbound_child_miss := v_call.direction = 'inbound' and not v_is_root
    and p_call_status in ('busy', 'no-answer', 'failed', 'canceled');
  v_call_status := case
    when p_call_status = 'in-progress' and (not v_is_root or v_call.direction = 'inbound') then 'answered'
    when p_call_status = 'completed' and (not v_is_root or v_call.answered_at is not null) then 'completed'
    when p_call_status = 'no-answer' then 'missed'
    when p_call_status = 'busy' or p_call_status = 'failed' then 'failed'
    when p_call_status = 'canceled' then 'canceled'
    when p_call_status = 'ringing' and v_call.status = 'initiated' then 'ringing'
    else v_call.status
  end;
  if v_inbound_child_miss then v_call_status := v_call.status; end if;
  update public.calls set
    status = case when status in ('completed', 'missed', 'failed', 'canceled') then status else v_call_status end,
    started_at = coalesce(started_at, case when p_call_status in ('initiated', 'ringing', 'in-progress', 'completed') then now() end),
    answered_at = coalesce(answered_at, case
      when not v_is_root and p_call_status in ('in-progress', 'completed') then now()
      when v_is_root and v_call.direction = 'inbound' and p_call_status = 'in-progress' then now()
    end),
    ended_at = coalesce(ended_at, case when not v_inbound_child_miss and p_call_status in ('completed', 'busy', 'no-answer', 'canceled', 'failed') then now() end),
    duration_seconds = case when not v_is_root and p_call_status = 'completed'
      then coalesce(p_call_duration, duration_seconds) else duration_seconds end,
    result_code = case when not v_inbound_child_miss and p_call_status in ('busy', 'no-answer', 'failed', 'canceled') then p_call_status else result_code end
   where organization_id = v_leg.organization_id and id = v_leg.call_id;
  if not v_inbound_child_miss and v_call_status in ('completed', 'missed', 'failed', 'canceled') then
    update public.call_reservations set status = 'released', expires_at = now()
     where organization_id = v_leg.organization_id and call_id = v_leg.call_id and status = 'active';
  end if;
  update public.provider_events set outcome = 'applied', applied_at = now() where id = v_event_id;
  return pg_catalog.jsonb_build_object('duplicate', false, 'callId', v_leg.call_id, 'status', v_call_status);
end;
$$;

create or replace function public.apply_call_status(
  p_account_sid text,
  p_call_sid text,
  p_parent_call_sid text,
  p_call_status text,
  p_call_duration integer default null
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select public.apply_call_status(
    p_account_sid, p_call_sid, p_parent_call_sid, p_call_status,
    p_call_duration, null::timestamptz, null::integer
  );
$$;

revoke all on function public.apply_call_status(text, text, text, text, integer, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.apply_call_status(text, text, text, text, integer, timestamptz, integer) to service_role;
revoke all on function public.apply_call_status(text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.apply_call_status(text, text, text, text, integer) to service_role;
