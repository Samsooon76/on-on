create index if not exists call_intents_reservation_id_idx on public.call_intents(reservation_id);

create or replace function public.issue_call_intent(
  p_org_id uuid,
  p_line_id uuid,
  p_device_id uuid,
  p_destination text,
  p_idempotency_key text,
  p_request_hash text,
  p_max_active_seconds integer default 900
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_idempotency_id uuid;
  v_request_hash text;
  v_response_body jsonb;
  v_status text;
  v_intent_id uuid;
  v_reservation_id uuid;
  v_allowed_destination boolean;
  v_daily_limit integer := 20;
  v_recent_intents integer;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 128
     or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$'
     or p_destination !~ '^\+[1-9][0-9]{7,14}$'
     or p_max_active_seconds not between 60 and 3600 then
    raise exception 'invalid call intent request' using errcode = '22023';
  end if;

  if not exists (
    select 1
      from public.memberships m
      join public.line_assignments a on a.organization_id = m.organization_id and a.user_id = m.user_id
      join public.lines l on l.organization_id = a.organization_id and l.id = a.line_id
      join public.devices d on d.organization_id = m.organization_id and d.user_id = m.user_id
     where m.organization_id = p_org_id and m.user_id = v_user_id and m.status = 'active'
       and a.line_id = p_line_id and a.status = 'active' and a.can_voice
       and l.status = 'active' and l.voice_enabled
       and d.id = p_device_id and d.status = 'active'
  ) then
    raise exception 'voice permission denied' using errcode = '42501';
  end if;

  select exists (
    select 1
      from public.organizations o,
           pg_catalog.jsonb_array_elements_text(
             coalesce(o.settings #> '{voice,allowedDestinationPrefixes}', '["+32"]'::jsonb)
           ) as prefix(value)
     where o.id = p_org_id and o.status = 'active'
       and prefix.value ~ '^\+[1-9][0-9]{0,14}$'
       and p_destination like prefix.value || '%'
  ) into v_allowed_destination;
  if not coalesce(v_allowed_destination, false) then
    raise exception 'destination not allowed' using errcode = '42501';
  end if;

  delete from public.idempotency_requests
   where organization_id = p_org_id and actor_user_id = v_user_id
     and operation = 'issue_call_intent' and idempotency_key = p_idempotency_key
     and expires_at <= now();
  insert into public.idempotency_requests (
    organization_id, actor_user_id, operation, idempotency_key, request_hash, expires_at
  ) values (
    p_org_id, v_user_id, 'issue_call_intent', p_idempotency_key, p_request_hash, now() + interval '24 hours'
  ) on conflict (organization_id, actor_user_id, operation, idempotency_key) do nothing
  returning id into v_idempotency_id;

  if v_idempotency_id is null then
    select id, request_hash, response_body, status
      into v_idempotency_id, v_request_hash, v_response_body, v_status
      from public.idempotency_requests
     where organization_id = p_org_id and actor_user_id = v_user_id
       and operation = 'issue_call_intent' and idempotency_key = p_idempotency_key
     for update;
    if v_request_hash is distinct from p_request_hash then
      raise exception 'idempotency key reused with different request' using errcode = '22023';
    end if;
    if v_status = 'completed' then return (v_response_body ->> 'intentId')::uuid; end if;
    raise exception 'request is already being processed' using errcode = '55000';
  end if;

  select case
           when (o.settings #>> '{voice,dailyCallLimit}') ~ '^[0-9]{1,3}$'
             then least(100, greatest(1, (o.settings #>> '{voice,dailyCallLimit}')::integer))
           else 20
         end
    into v_daily_limit
    from public.organizations o where o.id = p_org_id;
  select count(*)::integer into v_recent_intents
    from public.call_intents i
   where i.organization_id = p_org_id and i.user_id = v_user_id and i.created_at >= now() - interval '24 hours';
  if v_recent_intents >= v_daily_limit then
    raise exception 'daily call limit reached' using errcode = '54000';
  end if;

  update public.call_reservations set status = 'expired'
   where user_id = v_user_id and status in ('preparing', 'active') and expires_at <= now();
  insert into public.call_reservations (organization_id, user_id, status, expires_at)
  values (p_org_id, v_user_id, 'preparing', now() + pg_catalog.make_interval(secs => p_max_active_seconds))
  returning id into v_reservation_id;
  insert into public.call_intents (organization_id, user_id, device_id, line_id, destination, expires_at, reservation_id)
  values (p_org_id, v_user_id, p_device_id, p_line_id, p_destination, now() + interval '2 minutes', v_reservation_id)
  returning id into v_intent_id;
  update public.idempotency_requests
     set status = 'completed', response_status = 201, response_body = pg_catalog.jsonb_build_object('intentId', v_intent_id)
   where id = v_idempotency_id;
  return v_intent_id;
exception
  when unique_violation then
    raise exception 'user already has an active call reservation' using errcode = '55000';
end;
$$;

drop function public.consume_call_intent(uuid, text, text);

create function public.consume_call_intent(
  p_intent_id uuid,
  p_call_sid text,
  p_voice_identity text,
  p_account_sid text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.call_intents%rowtype;
  v_line public.lines%rowtype;
  v_call_id uuid;
  v_result jsonb;
begin
  if p_intent_id is null or p_call_sid is null or p_call_sid !~ '^CA[0-9a-fA-F]{32}$'
     or p_account_sid is null
     or p_voice_identity is null or length(p_voice_identity) > 121 then
    raise exception 'invalid call webhook payload' using errcode = '22023';
  end if;
  select * into v_intent from public.call_intents where id = p_intent_id for update;
  if not found then raise exception 'call intent not found' using errcode = 'P0002'; end if;

  if v_intent.status = 'consumed' then
    if v_intent.consumed_call_sid = p_call_sid then
      select pg_catalog.jsonb_build_object(
        'duplicate', true, 'callId', c.id, 'organizationId', c.organization_id,
        'lineId', c.line_id, 'destination', c.remote_number, 'callerId', l.phone_number, 'callSid', p_call_sid
      ) into v_result
        from public.call_legs leg
        join public.calls c on c.organization_id = leg.organization_id and c.id = leg.call_id
        join public.lines l on l.organization_id = c.organization_id and l.id = c.line_id
       where leg.organization_id = v_intent.organization_id and leg.provider_call_sid = p_call_sid;
      return v_result;
    end if;
    raise exception 'call intent already consumed' using errcode = '22023';
  end if;
  if v_intent.status <> 'issued' or v_intent.expires_at <= now() then
    update public.call_intents set status = 'expired' where id = p_intent_id and status = 'issued';
    raise exception 'call intent expired' using errcode = '22023';
  end if;
  select l.* into v_line
    from public.lines l
    join public.line_assignments a on a.organization_id = l.organization_id and a.line_id = l.id
    join public.memberships m on m.organization_id = a.organization_id and m.user_id = a.user_id
    join public.devices d on d.organization_id = a.organization_id and d.user_id = a.user_id
   where l.organization_id = v_intent.organization_id and l.id = v_intent.line_id
     and l.status = 'active' and l.voice_enabled
     and a.user_id = v_intent.user_id and a.status = 'active' and a.can_voice
     and m.status = 'active' and d.id = v_intent.device_id and d.status = 'active'
     and d.voice_identity = p_voice_identity and l.twilio_account_sid = p_account_sid;
  if not found then raise exception 'call permission revoked' using errcode = '42501'; end if;

  insert into public.calls (organization_id, line_id, direction, remote_number, status, started_at)
  values (v_intent.organization_id, v_intent.line_id, 'outbound', v_intent.destination, 'initiated', now())
  returning id into v_call_id;
  insert into public.call_legs (organization_id, call_id, device_id, provider_call_sid, status, started_at)
  values (v_intent.organization_id, v_call_id, v_intent.device_id, p_call_sid, 'initiated', now());
  update public.call_intents set status = 'consumed', consumed_call_sid = p_call_sid where id = p_intent_id;
  update public.call_reservations set status = 'active', call_id = v_call_id
   where id = v_intent.reservation_id and organization_id = v_intent.organization_id
     and user_id = v_intent.user_id and status = 'preparing';
  if not found then raise exception 'call reservation missing' using errcode = '55000'; end if;
  return pg_catalog.jsonb_build_object(
    'duplicate', false, 'callId', v_call_id, 'organizationId', v_intent.organization_id,
    'lineId', v_intent.line_id, 'destination', v_intent.destination, 'callerId', v_line.phone_number,
    'callSid', p_call_sid
  );
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
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_leg public.call_legs%rowtype;
  v_call public.calls%rowtype;
  v_leg_status text;
  v_call_status text;
  v_inserted_id uuid;
begin
  if p_account_sid is null or p_call_sid is null or p_call_sid !~ '^CA[0-9a-fA-F]{32}$'
     or (p_parent_call_sid is not null and p_parent_call_sid !~ '^CA[0-9a-fA-F]{32}$')
     or p_call_status not in ('initiated', 'ringing', 'in-progress', 'completed', 'busy', 'no-answer', 'canceled', 'failed')
     or (p_call_duration is not null and p_call_duration < 0) then
    raise exception 'invalid voice status payload' using errcode = '22023';
  end if;
  insert into public.provider_events (provider, provider_account_sid, resource_sid, event_type, dedupe_key)
  values ('twilio', p_account_sid, p_call_sid, 'voice.status.' || p_call_status,
          'voice:' || p_account_sid || ':' || p_call_sid || ':' || p_call_status)
  on conflict (dedupe_key) do nothing returning id into v_inserted_id;
  if v_inserted_id is null then return pg_catalog.jsonb_build_object('duplicate', true); end if;

  if p_parent_call_sid is not null then
    select * into v_leg from public.call_legs
     where provider_call_sid = p_parent_call_sid and organization_id = (
       select organization_id from public.lines where twilio_account_sid = p_account_sid limit 1
     ) for update;
    if not found then
      update public.provider_events set outcome = 'ignored', applied_at = now() where id = v_inserted_id;
      return pg_catalog.jsonb_build_object('duplicate', false, 'ignored', true);
    end if;
    if not exists (select 1 from public.call_legs where provider_call_sid = p_call_sid) then
      insert into public.call_legs (organization_id, call_id, provider_call_sid, parent_call_sid, status, started_at)
      values (v_leg.organization_id, v_leg.call_id, p_call_sid, p_parent_call_sid, 'initiated', now())
      on conflict (provider_call_sid) do nothing;
    end if;
  else
    select * into v_leg from public.call_legs where provider_call_sid = p_call_sid for update;
  end if;
  if v_leg.id is null then
    update public.provider_events set outcome = 'ignored', applied_at = now() where id = v_inserted_id;
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
    answered_at = coalesce(answered_at, case when p_call_status = 'in-progress' then now() end),
    ended_at = coalesce(ended_at, case when p_call_status in ('completed', 'busy', 'no-answer', 'canceled', 'failed') then now() end),
    duration_seconds = coalesce(p_call_duration, duration_seconds)
   where id = v_leg.id;

  select * into v_call from public.calls where organization_id = v_leg.organization_id and id = v_leg.call_id for update;
  v_call_status := case
    when p_call_status = 'in-progress' then 'answered'
    when p_call_status = 'completed' and (p_call_duration > 0 or v_call.answered_at is not null) then 'completed'
    when p_call_status = 'completed' or p_call_status = 'no-answer' then 'missed'
    when p_call_status = 'busy' or p_call_status = 'failed' then 'failed'
    when p_call_status = 'canceled' then 'canceled'
    when p_call_status = 'ringing' and v_call.status = 'initiated' then 'ringing'
    else v_call.status
  end;
  update public.calls set
    status = case when status in ('completed', 'missed', 'failed', 'canceled') then status else v_call_status end,
    started_at = coalesce(started_at, case when p_call_status in ('initiated', 'ringing', 'in-progress') then now() end),
    answered_at = coalesce(answered_at, case when p_call_status = 'in-progress' then now() end),
    ended_at = coalesce(ended_at, case when p_call_status in ('completed', 'busy', 'no-answer', 'canceled', 'failed') then now() end),
    duration_seconds = coalesce(p_call_duration, duration_seconds),
    result_code = case when p_call_status in ('busy', 'no-answer', 'failed', 'canceled') then p_call_status else result_code end
   where organization_id = v_leg.organization_id and id = v_leg.call_id;
  if v_call_status in ('completed', 'missed', 'failed', 'canceled') then
    update public.call_reservations set status = 'released', expires_at = now()
     where organization_id = v_leg.organization_id and call_id = v_leg.call_id and status = 'active';
  end if;
  update public.provider_events set outcome = 'applied', applied_at = now() where id = v_inserted_id;
  return pg_catalog.jsonb_build_object('duplicate', false, 'callId', v_leg.call_id, 'status', v_call_status);
end;
$$;

revoke all on function public.issue_call_intent(uuid, uuid, uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.issue_call_intent(uuid, uuid, uuid, text, text, text, integer) to authenticated;
revoke all on function public.consume_call_intent(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.consume_call_intent(uuid, text, text, text) to service_role;
revoke all on function public.apply_call_status(text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.apply_call_status(text, text, text, text, integer) to service_role;
