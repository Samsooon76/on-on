alter table public.call_intents
  add column reservation_id uuid references public.call_reservations(id) on delete restrict;

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
  v_response_status integer;
  v_status text;
  v_intent_id uuid;
  v_reservation_id uuid;
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
      join public.line_assignments a
        on a.organization_id = m.organization_id and a.user_id = m.user_id
      join public.lines l
        on l.organization_id = a.organization_id and l.id = a.line_id
      join public.devices d
        on d.organization_id = m.organization_id and d.user_id = m.user_id
     where m.organization_id = p_org_id
       and m.user_id = v_user_id
       and m.status = 'active'
       and a.line_id = p_line_id
       and a.status = 'active'
       and a.can_voice
       and l.status = 'active'
       and l.voice_enabled
       and d.id = p_device_id
       and d.status = 'active'
  ) then
    raise exception 'voice permission denied' using errcode = '42501';
  end if;

  delete from public.idempotency_requests
   where organization_id = p_org_id
     and actor_user_id = v_user_id
     and operation = 'issue_call_intent'
     and idempotency_key = p_idempotency_key
     and expires_at <= now();

  insert into public.idempotency_requests (
    organization_id, actor_user_id, operation, idempotency_key, request_hash, expires_at
  ) values (
    p_org_id, v_user_id, 'issue_call_intent', p_idempotency_key, p_request_hash, now() + interval '24 hours'
  )
  on conflict (organization_id, actor_user_id, operation, idempotency_key) do nothing
  returning id into v_idempotency_id;

  if v_idempotency_id is null then
    select id, request_hash, response_body, response_status, status
      into v_idempotency_id, v_request_hash, v_response_body, v_response_status, v_status
      from public.idempotency_requests
     where organization_id = p_org_id
       and actor_user_id = v_user_id
       and operation = 'issue_call_intent'
       and idempotency_key = p_idempotency_key
     for update;

    if v_request_hash is distinct from p_request_hash then
      raise exception 'idempotency key reused with different request' using errcode = '22023';
    end if;
    if v_status = 'completed' then
      return (v_response_body ->> 'intentId')::uuid;
    end if;
    raise exception 'request is already being processed' using errcode = '55000';
  end if;

  update public.call_reservations
     set status = 'expired'
   where user_id = v_user_id
     and status in ('preparing', 'active')
     and expires_at <= now();

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

create or replace function public.consume_call_intent(
  p_intent_id uuid,
  p_call_sid text,
  p_voice_identity text
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
     or p_voice_identity is null or length(p_voice_identity) > 121 then
    raise exception 'invalid call webhook payload' using errcode = '22023';
  end if;

  select * into v_intent
    from public.call_intents
   where id = p_intent_id
   for update;
  if not found then
    raise exception 'call intent not found' using errcode = 'P0002';
  end if;

  if v_intent.status = 'consumed' then
    if v_intent.consumed_call_sid = p_call_sid then
      select pg_catalog.jsonb_build_object(
        'duplicate', true, 'callId', c.id, 'organizationId', c.organization_id,
        'lineId', c.line_id, 'destination', c.remote_number, 'callerId', l.phone_number, 'callSid', p_call_sid
      )
        into v_result
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
     and d.voice_identity = p_voice_identity;
  if not found then
    raise exception 'call permission revoked' using errcode = '42501';
  end if;

  insert into public.calls (organization_id, line_id, direction, remote_number, status, started_at)
  values (v_intent.organization_id, v_intent.line_id, 'outbound', v_intent.destination, 'initiated', now())
  returning id into v_call_id;

  insert into public.call_legs (organization_id, call_id, device_id, provider_call_sid, status, started_at)
  values (v_intent.organization_id, v_call_id, v_intent.device_id, p_call_sid, 'initiated', now());

  update public.call_intents set status = 'consumed', consumed_call_sid = p_call_sid where id = p_intent_id;
  update public.call_reservations
     set status = 'active', call_id = v_call_id, expires_at = now() + interval '15 minutes'
   where id = v_intent.reservation_id and organization_id = v_intent.organization_id
     and user_id = v_intent.user_id and status = 'preparing';
  if not found then
    raise exception 'call reservation missing' using errcode = '55000';
  end if;

  return pg_catalog.jsonb_build_object(
    'duplicate', false, 'callId', v_call_id, 'organizationId', v_intent.organization_id,
    'lineId', v_intent.line_id, 'destination', v_intent.destination, 'callerId', v_line.phone_number,
    'callSid', p_call_sid
  );
end;
$$;

revoke all on function public.issue_call_intent(uuid, uuid, uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.issue_call_intent(uuid, uuid, uuid, text, text, text, integer) to authenticated;
revoke all on function public.consume_call_intent(uuid, text, text) from public, anon, authenticated;
grant execute on function public.consume_call_intent(uuid, text, text) to service_role;
