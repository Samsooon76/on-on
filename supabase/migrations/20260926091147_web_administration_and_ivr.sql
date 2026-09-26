-- Privileged writes remain behind service-only RPCs; clients cannot edit their own role.
alter table public.memberships add column display_name text not null default '' check (length(display_name) <= 120);
alter table public.lines add column ivr_config jsonb not null default '{"enabled":false,"greeting":"Bienvenue. Merci de choisir votre interlocuteur.","language":"fr-FR","timeout":5,"maxAttempts":2,"fallback":"all","options":[]}'::jsonb;
alter table public.calls add column ivr_state jsonb;

create function private.require_admin(p_org_id uuid, p_actor_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  -- All administrative mutations serialize here, including last-admin checks.
  perform 1 from public.organizations where id = p_org_id and status = 'active' for update;
  if not found or not exists (select 1 from public.memberships where organization_id = p_org_id and user_id = p_actor_id and status = 'active' and role = 'admin') then
    raise exception 'Active organization administrator required' using errcode = '42501';
  end if;
end; $$;
revoke all on function private.require_admin(uuid, uuid) from public, anon, authenticated;
grant execute on function private.require_admin(uuid, uuid) to service_role;

create function public.admin_snapshot(p_org_id uuid, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin(p_org_id, p_actor_id);
  return jsonb_build_object(
    'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'display_name', coalesce(nullif(m.display_name,''), u.email), 'role', m.role, 'status', m.status, 'updated_at', m.updated_at) order by m.created_at, m.user_id) from public.memberships m join auth.users u on u.id = m.user_id where m.organization_id = p_org_id), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'phone_number', l.phone_number, 'status', l.status, 'voice_enabled', l.voice_enabled, 'sms_enabled', l.sms_enabled, 'ivr_config', l.ivr_config, 'updated_at', l.updated_at) order by l.created_at, l.id) from public.lines l where l.organization_id = p_org_id), '[]'::jsonb),
    'assignments', coalesce((select jsonb_agg(jsonb_build_object('line_id', a.line_id, 'user_id', a.user_id, 'can_voice', a.can_voice, 'can_sms', a.can_sms, 'status', a.status)) from public.line_assignments a where a.organization_id = p_org_id), '[]'::jsonb),
    'audit', coalesce((select jsonb_agg(to_jsonb(e)) from (select id, actor_user_id, action, target_type, target_id, created_at from public.audit_events where organization_id = p_org_id order by created_at desc, id desc limit 50) e), '[]'::jsonb)
  );
end; $$;

create function public.admin_create_member(p_org_id uuid, p_actor_id uuid, p_user_id uuid, p_display_name text, p_role text)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin(p_org_id, p_actor_id);
  if p_role is null or p_role not in ('admin','member') or p_display_name is null or length(btrim(p_display_name)) not between 1 and 120 then
    raise exception 'Invalid member' using errcode = '22023';
  end if;
  insert into public.memberships(organization_id, user_id, display_name, role) values(p_org_id,p_user_id,btrim(p_display_name),p_role);
  insert into public.audit_events(organization_id,actor_user_id,action,target_type,target_id,outcome) values(p_org_id,p_actor_id,'member.create','member',p_user_id,'allowed');
  return p_user_id;
end; $$;

create function public.admin_update_member(p_org_id uuid, p_actor_id uuid, p_user_id uuid, p_display_name text, p_role text, p_status text, p_version timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_member public.memberships%rowtype;
begin
  perform private.require_admin(p_org_id, p_actor_id);
  select * into v_member from public.memberships where organization_id = p_org_id and user_id = p_user_id for update;
  if not found then raise exception 'Member not found' using errcode = 'P0002'; end if;
  if p_version is distinct from v_member.updated_at then raise exception 'Stale member' using errcode = '40001'; end if;
  if p_role is null or p_role not in ('admin','member') or p_status is null or p_status not in ('active','suspended','revoked') or p_display_name is null or length(btrim(p_display_name)) not between 1 and 120 then
    raise exception 'Invalid member' using errcode = '22023';
  end if;
  if v_member.role = 'admin' and v_member.status = 'active' and (p_role <> 'admin' or p_status <> 'active') and not exists(select 1 from public.memberships where organization_id = p_org_id and user_id <> p_user_id and role = 'admin' and status = 'active') then
    raise exception 'Last administrator' using errcode = '23514';
  end if;
  update public.memberships set display_name = btrim(p_display_name), role = p_role, status = p_status where organization_id = p_org_id and user_id = p_user_id;
  if p_status <> 'active' then
    update public.devices set voice_registered_at = null where organization_id = p_org_id and user_id = p_user_id;
    update public.call_intents set status = 'canceled' where organization_id = p_org_id and user_id = p_user_id and status = 'issued';
    update public.call_reservations set status = 'released', expires_at = now() where organization_id = p_org_id and user_id = p_user_id and status = 'preparing';
  end if;
  if p_status = 'revoked' then
    update public.line_assignments set status = 'revoked', can_voice = false, can_sms = false where organization_id = p_org_id and user_id = p_user_id;
  end if;
  insert into public.audit_events(organization_id,actor_user_id,action,target_type,target_id,outcome) values(p_org_id,p_actor_id,'member.update','member',p_user_id,'allowed');
  return p_user_id;
end; $$;

create function public.admin_set_ivr(p_org_id uuid, p_actor_id uuid, p_line_id uuid, p_config jsonb, p_version timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_line public.lines%rowtype; v_option jsonb;
begin
  perform private.require_admin(p_org_id, p_actor_id);
  select * into v_line from public.lines where organization_id = p_org_id and id = p_line_id for update;
  if not found then raise exception 'Line not found' using errcode = 'P0002'; end if;
  if p_version is distinct from v_line.updated_at then raise exception 'Stale IVR' using errcode = '40001'; end if;
  if coalesce(p_config is null or jsonb_typeof(p_config) <> 'object'
    or not (p_config ?& array['enabled','greeting','language','timeout','maxAttempts','fallback','options'])
    or jsonb_typeof(p_config->'enabled') <> 'boolean' or jsonb_typeof(p_config->'greeting') <> 'string'
    or length(btrim(p_config->>'greeting')) not between 1 and 1000
    or p_config->>'language' not in ('fr-FR','en-GB','en-US')
    or p_config->>'fallback' not in ('all','hangup')
    or (p_config->>'timeout') !~ '^(3|4|5|6|7|8|9|10|11|12|13|14|15)$'
    or (p_config->>'maxAttempts') !~ '^[1-3]$'
    or jsonb_typeof(p_config->'options') <> 'array', true) then
    raise exception 'Invalid IVR' using errcode = '22023';
  end if;
  if jsonb_array_length(p_config->'options') > 10 or ((p_config->>'enabled')::boolean and (jsonb_array_length(p_config->'options') = 0 or not v_line.voice_enabled or v_line.status <> 'active')) then
    raise exception 'Invalid IVR options or line' using errcode = '22023';
  end if;
  if (select count(*) <> count(distinct value->>'digit') from jsonb_array_elements(p_config->'options')) then raise exception 'Duplicate digit' using errcode = '22023'; end if;
  for v_option in select value from jsonb_array_elements(p_config->'options') loop
    if coalesce(jsonb_typeof(v_option) <> 'object' or not (v_option ?& array['digit','label','userId']) or jsonb_typeof(v_option->'digit') <> 'string' or jsonb_typeof(v_option->'label') <> 'string' or jsonb_typeof(v_option->'userId') not in ('string','null') or (v_option->>'digit') !~ '^[0-9]$' or length(btrim(v_option->>'label')) not between 1 and 80, true) then raise exception 'Invalid option' using errcode = '22023'; end if;
    if (p_config->>'enabled')::boolean and v_option->>'userId' is not null and not exists(select 1 from public.line_assignments a join public.memberships m using(organization_id,user_id) where a.organization_id = p_org_id and a.line_id = p_line_id and a.user_id = (v_option->>'userId')::uuid and a.status = 'active' and a.can_voice and m.status = 'active') then
      raise exception 'IVR target needs active voice assignment' using errcode = '23503';
    end if;
  end loop;
  update public.lines set ivr_config = p_config where organization_id = p_org_id and id = p_line_id;
  insert into public.audit_events(organization_id,actor_user_id,action,target_type,target_id,outcome) values(p_org_id,p_actor_id,'ivr.update','line',p_line_id,'allowed');
  return p_line_id;
end; $$;

revoke all on function public.admin_snapshot(uuid,uuid), public.admin_create_member(uuid,uuid,uuid,text,text), public.admin_update_member(uuid,uuid,uuid,text,text,text,timestamptz), public.admin_set_ivr(uuid,uuid,uuid,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.admin_snapshot(uuid,uuid), public.admin_create_member(uuid,uuid,uuid,text,text), public.admin_update_member(uuid,uuid,uuid,text,text,text,timestamptz), public.admin_set_ivr(uuid,uuid,uuid,jsonb,timestamptz) to service_role;

create or replace function public.route_inbound_call(
  p_account_sid text,
  p_call_sid text,
  p_from text,
  p_to text,
  p_max_ringing_devices integer default 4,
  p_digits text default null,
  p_attempt integer default 0
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
  v_state jsonb;
  v_config jsonb;
  v_target_user uuid;
  v_option jsonb;
  v_call_status text;
begin
  if p_account_sid is null or p_call_sid is null or p_call_sid !~ '^CA[0-9a-fA-F]{32}$'
     or p_from is null or p_to is null or p_max_ringing_devices is null
     or p_from !~ '^\+[1-9][0-9]{7,14}$' or p_to !~ '^\+[1-9][0-9]{7,14}$'
     or p_max_ringing_devices not between 1 and 8 then
    raise exception 'invalid inbound voice payload' using errcode = '22023';
  end if;

  if p_attempt is null or p_attempt not between 0 and 3 then raise exception 'Invalid IVR attempt' using errcode = '22023'; end if;
  -- Serialize webhook retries and choices for the same call before deduplication.
  perform pg_advisory_xact_lock(hashtextextended(p_account_sid || ':' || p_call_sid, 0));
  select * into v_line from public.lines
   where twilio_account_sid = p_account_sid and phone_number = p_to
     and status = 'active' and voice_enabled;
  if not found or not exists(select 1 from public.organizations where id = v_line.organization_id and status = 'active') then
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
  else
    insert into public.calls (organization_id, line_id, direction, remote_number, status, started_at, ivr_state)
    values (v_line.organization_id, v_line.id, 'inbound', p_from, 'ringing', now(),
      case when (v_line.ivr_config->>'enabled')::boolean then jsonb_build_object('config',v_line.ivr_config,'attempt',0,'routed',false) end)
    returning id into v_call_id;
    insert into public.call_legs (organization_id, call_id, provider_call_sid, status, started_at)
    values (v_line.organization_id, v_call_id, p_call_sid, 'ringing', now());
  end if;
  select ivr_state, status into v_state, v_call_status from public.calls where id = v_call_id and organization_id = v_line.organization_id for update;
  if v_call_status in ('completed','missed','failed','canceled') then
    return jsonb_build_object('allowed',true,'callId',v_call_id,'devices','[]'::jsonb);
  end if;
  if v_state is not null then
    v_config := v_state->'config';
    if not (v_state->>'routed')::boolean then
      if p_attempt = (v_state->>'attempt')::integer + 1 then
        select value into v_option from jsonb_array_elements(v_config->'options') where value->>'digit' = p_digits;
        v_state := jsonb_set(v_state,'{attempt}',to_jsonb(p_attempt));
        if v_option is not null then
          v_state := v_state || jsonb_build_object('routed',true,'targetUserId',v_option->'userId');
        elsif p_attempt >= (v_config->>'maxAttempts')::integer then
          if v_config->>'fallback' = 'hangup' then
            update public.calls set status = 'missed', ended_at = now(), result_code = 'ivr_no_selection', ivr_state = v_state where id = v_call_id;
            update public.call_legs set status = 'completed', ended_at = now() where provider_call_sid = p_call_sid;
            update public.provider_events set outcome = 'applied', applied_at = now() where id = v_event_id;
            return jsonb_build_object('allowed',true,'hangup',true,'callId',v_call_id,'language',v_config->>'language');
          end if;
          v_state := v_state || jsonb_build_object('routed',true,'targetUserId',null);
        end if;
      end if;
      update public.calls set ivr_state = v_state where id = v_call_id;
      if not (v_state->>'routed')::boolean then
        update public.provider_events set outcome = 'applied', applied_at = now() where id = v_event_id;
        return jsonb_build_object('allowed',true,'callId',v_call_id,'ivr',v_config,'attempt',(v_state->>'attempt')::integer);
      end if;
      -- This request just resolved the menu: reserve eligible recipients now.
      v_duplicate := false;
    end if;
    v_target_user := (v_state->>'targetUserId')::uuid;
  end if;
  if v_duplicate then
    select coalesce(jsonb_agg(jsonb_build_object('deviceId', chosen.id, 'identity', chosen.voice_identity) order by chosen.last_active_at desc nulls last, chosen.id), '[]'::jsonb)
      into v_devices from (select d.id, d.voice_identity, d.last_active_at
      from public.devices d
      join public.call_reservations r on r.organization_id = d.organization_id and r.user_id = d.user_id
      join public.line_assignments a on a.organization_id = r.organization_id and a.line_id = v_line.id and a.user_id = r.user_id
      join public.memberships m on m.organization_id = r.organization_id and m.user_id = r.user_id
     where r.organization_id = v_org_id and r.call_id = v_call_id and r.status = 'active'
       and r.expires_at > now() and d.status = 'active' and d.voice_registered_at is not null and (d.platform in ('ios','android') or d.voice_registered_at > now() - interval '90 seconds')
       and (v_target_user is null or d.user_id = v_target_user) and a.status = 'active' and a.can_voice and m.status = 'active'
      order by d.last_active_at desc nulls last, d.id limit p_max_ringing_devices) chosen;
    return pg_catalog.jsonb_build_object('allowed', true, 'duplicate', true, 'callId', v_call_id,
      'organizationId', v_org_id, 'lineId', v_line.id, 'callerNumber', p_from, 'lineNumber', p_to, 'devices', v_devices);
  end if;

  for v_eligible_user in
    select a.user_id
      from public.line_assignments a
      join public.memberships m on m.organization_id = a.organization_id and m.user_id = a.user_id
     where a.organization_id = v_line.organization_id and a.line_id = v_line.id
       and a.status = 'active' and a.can_voice and m.status = 'active'
       and (v_target_user is null or a.user_id = v_target_user)
       and exists (select 1 from public.devices d where d.organization_id = a.organization_id
                   and d.user_id = a.user_id and d.status = 'active'
                     and d.voice_registered_at is not null and (d.platform in ('ios','android') or d.voice_registered_at > now() - interval '90 seconds'))
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
         and d.voice_registered_at is not null and (d.platform in ('ios','android') or d.voice_registered_at > now() - interval '90 seconds')
       order by d.last_active_at desc nulls last, d.id
       limit p_max_ringing_devices
    ) selected;

  update public.call_reservations r set status = 'released', expires_at = now()
    where r.call_id = v_call_id and r.status = 'active'
      and not exists(select 1 from public.devices d join jsonb_array_elements(v_devices) item on d.id = (item->>'deviceId')::uuid where d.user_id = r.user_id);

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

revoke all on function public.route_inbound_call(text,text,text,text,integer,text,integer) from public,anon,authenticated;
grant execute on function public.route_inbound_call(text,text,text,text,integer,text,integer) to service_role;
-- Preserve the existing signature for old API deployments during rollout.
create or replace function public.begin_inbound_call(p_account_sid text,p_call_sid text,p_from text,p_to text,p_max_ringing_devices integer default 4)
returns jsonb language sql security definer set search_path = '' as $$
  select public.route_inbound_call(p_account_sid,p_call_sid,p_from,p_to,p_max_ringing_devices,null,0);
$$;
