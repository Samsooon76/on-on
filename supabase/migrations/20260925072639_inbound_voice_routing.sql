create or replace function public.begin_inbound_call(
  p_account_sid text,
  p_call_sid text,
  p_from text,
  p_to text,
  p_max_ringing_devices integer default 4
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line public.lines%rowtype;
  v_call_id uuid;
  v_org_id uuid;
  v_event_id uuid;
  v_reservation_id uuid;
  v_user_id uuid;
  v_eligible_user record;
  v_reserved_users uuid[] := array[]::uuid[];
  v_devices jsonb := '[]'::jsonb;
  v_duplicate boolean := false;
begin
  if p_account_sid is null or p_call_sid is null or p_call_sid !~ '^CA[0-9a-fA-F]{32}$'
     or p_from !~ '^\+[1-9][0-9]{7,14}$' or p_to !~ '^\+[1-9][0-9]{7,14}$'
     or p_max_ringing_devices not between 1 and 8 then
    raise exception 'invalid inbound voice payload' using errcode = '22023';
  end if;

  select * into v_line from public.lines
   where twilio_account_sid = p_account_sid and phone_number = p_to
     and status = 'active' and voice_enabled;
  if not found then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'line_unavailable');
  end if;

  insert into public.provider_events (provider, provider_account_sid, resource_sid, event_type, dedupe_key)
  values ('twilio', p_account_sid, p_call_sid, 'voice.inbound', 'voice:inbound:' || p_account_sid || ':' || p_call_sid)
  on conflict (dedupe_key) do nothing returning id into v_event_id;
  if v_event_id is null then v_duplicate := true; end if;

  if v_duplicate then
    select c.id, c.organization_id into v_call_id, v_org_id
      from public.call_legs leg
      join public.calls c on c.organization_id = leg.organization_id and c.id = leg.call_id
     where leg.provider_call_sid = p_call_sid;
    if v_call_id is null then return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'call_unavailable'); end if;
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('deviceId', d.id, 'identity', d.voice_identity)
      order by d.last_active_at desc nulls last, d.id), '[]'::jsonb)
      into v_devices
      from public.devices d
      join public.call_reservations r on r.organization_id = d.organization_id and r.user_id = d.user_id
      join public.line_assignments a on a.organization_id = r.organization_id and a.line_id = v_line.id and a.user_id = r.user_id
      join public.memberships m on m.organization_id = r.organization_id and m.user_id = r.user_id
     where r.organization_id = v_org_id and r.call_id = v_call_id and r.status = 'active'
       and r.expires_at > now() and d.status = 'active' and a.status = 'active' and a.can_voice and m.status = 'active';
    return pg_catalog.jsonb_build_object('allowed', true, 'duplicate', true, 'callId', v_call_id,
      'organizationId', v_org_id, 'lineId', v_line.id, 'callerNumber', p_from, 'lineNumber', p_to, 'devices', v_devices);
  end if;

  insert into public.calls (organization_id, line_id, direction, remote_number, status, started_at)
  values (v_line.organization_id, v_line.id, 'inbound', p_from, 'ringing', now())
  returning id into v_call_id;
  insert into public.call_legs (organization_id, call_id, provider_call_sid, status, started_at)
  values (v_line.organization_id, v_call_id, p_call_sid, 'ringing', now());

  for v_eligible_user in
    select a.user_id
      from public.line_assignments a
      join public.memberships m on m.organization_id = a.organization_id and m.user_id = a.user_id
     where a.organization_id = v_line.organization_id and a.line_id = v_line.id
       and a.status = 'active' and a.can_voice and m.status = 'active'
       and exists (select 1 from public.devices d where d.organization_id = a.organization_id
                   and d.user_id = a.user_id and d.status = 'active')
       and not exists (select 1 from public.call_reservations r where r.user_id = a.user_id
                       and r.status in ('preparing', 'active') and r.expires_at > now())
     group by a.user_id
     order by min(a.created_at), a.user_id
  loop
    insert into public.call_reservations (organization_id, user_id, call_id, status, expires_at)
    values (v_line.organization_id, v_eligible_user.user_id, v_call_id, 'active', now() + interval '35 seconds')
    on conflict (user_id) where status in ('preparing', 'active') do nothing
    returning id into v_reservation_id;
    if v_reservation_id is not null then
      v_reserved_users := pg_catalog.array_append(v_reserved_users, v_eligible_user.user_id);
      v_reservation_id := null;
    end if;
  end loop;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('deviceId', selected.id, 'identity', selected.voice_identity)
      order by selected.last_active_at desc nulls last, selected.id), '[]'::jsonb)
    into v_devices
    from (
      select d.id, d.voice_identity, d.last_active_at
        from public.devices d
       where d.organization_id = v_line.organization_id and d.user_id = any(v_reserved_users) and d.status = 'active'
       order by d.last_active_at desc nulls last, d.id
       limit p_max_ringing_devices
    ) selected;

  if pg_catalog.jsonb_array_length(v_devices) = 0 then
    update public.calls set status = 'missed', ended_at = now(), result_code = 'no_available_device'
     where organization_id = v_line.organization_id and id = v_call_id;
    update public.call_legs set status = 'completed', ended_at = now()
     where organization_id = v_line.organization_id and provider_call_sid = p_call_sid;
    update public.provider_events set outcome = 'ignored', applied_at = now() where id = v_event_id;
    return pg_catalog.jsonb_build_object('allowed', true, 'duplicate', false, 'callId', v_call_id,
      'organizationId', v_line.organization_id, 'lineId', v_line.id, 'callerNumber', p_from,
      'lineNumber', p_to, 'devices', v_devices);
  end if;

  update public.provider_events set outcome = 'applied', applied_at = now() where id = v_event_id;
  return pg_catalog.jsonb_build_object('allowed', true, 'duplicate', false, 'callId', v_call_id,
    'organizationId', v_line.organization_id, 'lineId', v_line.id, 'callerNumber', p_from,
    'lineNumber', p_to, 'devices', v_devices);
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
     or (p_call_duration is not null and p_call_duration < 0) then
    raise exception 'invalid voice status payload' using errcode = '22023';
  end if;
  insert into public.provider_events (provider, provider_account_sid, resource_sid, event_type, dedupe_key)
  values ('twilio', p_account_sid, p_call_sid, 'voice.status.' || p_call_status,
          'voice:' || p_account_sid || ':' || p_call_sid || ':' || p_call_status)
  on conflict (dedupe_key) do nothing returning id into v_event_id;
  if v_event_id is null then return pg_catalog.jsonb_build_object('duplicate', true); end if;

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
    answered_at = coalesce(answered_at, case when p_call_status = 'in-progress' then now() end),
    ended_at = coalesce(ended_at, case when p_call_status in ('completed', 'busy', 'no-answer', 'canceled', 'failed') then now() end),
    duration_seconds = coalesce(p_call_duration, duration_seconds)
   where id = v_leg.id;

  select * into v_call from public.calls where organization_id = v_leg.organization_id and id = v_leg.call_id for update;
  v_inbound_child_miss := v_call.direction = 'inbound' and not v_is_root
    and p_call_status in ('busy', 'no-answer', 'failed', 'canceled');
  v_call_status := case
    when p_call_status = 'in-progress' then 'answered'
    when p_call_status = 'completed' and (coalesce(p_call_duration, 0) > 0 or v_call.answered_at is not null) then 'completed'
    when p_call_status = 'completed' or p_call_status = 'no-answer' then 'missed'
    when p_call_status = 'busy' or p_call_status = 'failed' then 'failed'
    when p_call_status = 'canceled' then 'canceled'
    when p_call_status = 'ringing' and v_call.status = 'initiated' then 'ringing'
    else v_call.status
  end;
  if v_inbound_child_miss then v_call_status := v_call.status; end if;
  update public.calls set
    status = case when status in ('completed', 'missed', 'failed', 'canceled') then status else v_call_status end,
    started_at = coalesce(started_at, case when p_call_status in ('initiated', 'ringing', 'in-progress') then now() end),
    answered_at = coalesce(answered_at, case when p_call_status = 'in-progress' then now() end),
    ended_at = coalesce(ended_at, case when not v_inbound_child_miss and p_call_status in ('completed', 'busy', 'no-answer', 'canceled', 'failed') then now() end),
    duration_seconds = coalesce(p_call_duration, duration_seconds),
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

revoke all on function public.begin_inbound_call(text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.begin_inbound_call(text, text, text, text, integer) to service_role;
revoke all on function public.apply_call_status(text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.apply_call_status(text, text, text, text, integer) to service_role;
