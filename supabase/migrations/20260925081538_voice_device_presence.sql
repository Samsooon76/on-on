alter table public.devices
  add column voice_registered_at timestamptz;

create index devices_active_voice_registration_idx
  on public.devices (organization_id, user_id, voice_registered_at desc)
  where status = 'active' and voice_registered_at is not null;

create or replace function public.set_device_voice_state(
  p_device_id uuid,
  p_registered boolean
)
returns boolean
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
  if p_device_id is null or p_registered is null then
    raise exception 'invalid device voice state' using errcode = '22023';
  end if;

  update public.devices d
     set voice_registered_at = case when p_registered then now() else null end,
         last_active_at = case when p_registered then now() else d.last_active_at end
   where d.id = p_device_id and d.user_id = v_user_id and d.status = 'active'
     and exists (
       select 1 from public.memberships m
       where m.organization_id = d.organization_id and m.user_id = v_user_id and m.status = 'active'
     );
  if not found then
    raise exception 'active device not found' using errcode = '42501';
  end if;
  return true;
end;
$$;

revoke all on function public.set_device_voice_state(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_device_voice_state(uuid, boolean) to authenticated;

create or replace function private.broadcast_activity_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_topic text;
  v_payload jsonb;
  v_line_id uuid;
begin
  if tg_table_name = 'contacts' then
    v_topic := 'org:' || new.organization_id::text || ':contacts';
    v_payload := pg_catalog.jsonb_build_object(
      'kind', 'contact', 'resourceId', new.id, 'version', new.version, 'occurredAt', pg_catalog.now()
    );
  elsif tg_table_name = 'calls' then
    v_topic := 'line:' || new.line_id::text || ':voice';
    v_payload := pg_catalog.jsonb_build_object(
      'kind', 'call', 'resourceId', new.id, 'status', new.status, 'occurredAt', pg_catalog.now()
    );
  elsif tg_table_name = 'messages' then
    select c.line_id into v_line_id
      from public.conversations c
     where c.organization_id = new.organization_id and c.id = new.conversation_id;
    if v_line_id is not null then
      v_topic := 'line:' || v_line_id::text || ':sms';
      v_payload := pg_catalog.jsonb_build_object(
        'kind', 'message', 'resourceId', new.conversation_id, 'status', new.status, 'occurredAt', pg_catalog.now()
      );
    end if;
  elsif tg_table_name = 'devices' then
    if tg_op = 'INSERT' then
      v_topic := 'user:' || new.user_id::text || ':devices';
      v_payload := pg_catalog.jsonb_build_object(
        'kind', 'device', 'resourceId', new.id, 'status', new.status, 'occurredAt', pg_catalog.now()
      );
    elsif old.status is distinct from new.status then
      v_topic := 'user:' || new.user_id::text || ':devices';
      v_payload := pg_catalog.jsonb_build_object(
        'kind', 'device', 'resourceId', new.id, 'status', new.status, 'occurredAt', pg_catalog.now()
      );
    end if;
  end if;

  if v_topic is not null then
    perform realtime.send(v_payload, 'onoff.activity', v_topic, true);
  end if;
  return new;
end;
$$;

revoke all on function private.broadcast_activity_event() from public, anon, authenticated;
grant execute on function private.broadcast_activity_event() to service_role;

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
       and r.expires_at > now() and d.status = 'active' and d.voice_registered_at > now() - interval '90 seconds'
       and a.status = 'active' and a.can_voice and m.status = 'active';
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
                   and d.user_id = a.user_id and d.status = 'active'
                     and d.voice_registered_at > now() - interval '90 seconds')
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
         and d.voice_registered_at > now() - interval '90 seconds'
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
