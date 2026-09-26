-- Configuration is private to the server. Twilio remains the source of live state.
create table public.voice_workspaces (
  organization_id uuid primary key references public.organizations(id),
  workspace_sid text unique,
  activities jsonb not null default '{}',
  lock_token uuid,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
create table public.voice_queues (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id),
  line_id uuid not null,
  config jsonb not null,
  synced_version integer not null default 0,
  queue_sid text unique,
  workflow_sid text unique,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  foreign key (organization_id,line_id) references public.lines(organization_id,id),
  unique (organization_id,id)
);
create index voice_queues_line_idx on public.voice_queues(organization_id,line_id);
create table public.voice_agents (
  organization_id uuid not null,
  user_id uuid not null,
  worker_sid text unique not null,
  contact_number text check(contact_number is null or contact_number ~ '^\+[1-9][0-9]{7,14}$'),
  primary key(organization_id,user_id),
  foreign key(organization_id,user_id) references public.memberships(organization_id,user_id)
);
create table public.voice_flows (
  line_id uuid primary key,
  organization_id uuid not null,
  draft jsonb not null,
  published jsonb,
  version integer not null default 1,
  published_at timestamptz,
  foreign key(organization_id,line_id) references public.lines(organization_id,id)
);
create index voice_flows_org_idx on public.voice_flows(organization_id);
create table public.voice_voicemails (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  call_id uuid not null,
  recording_sid text unique not null check(recording_sid ~ '^RE[0-9a-fA-F]{32}$'),
  duration integer not null check(duration >= 0),
  created_at timestamptz not null default now(),
  foreign key(organization_id,call_id) references public.calls(organization_id,id)
);
create index voice_voicemails_org_idx on public.voice_voicemails(organization_id,created_at desc);
create index voice_voicemails_call_idx on public.voice_voicemails(call_id);
alter table public.voice_workspaces enable row level security;
alter table public.voice_queues enable row level security;
alter table public.voice_agents enable row level security;
alter table public.voice_flows enable row level security;
alter table public.voice_voicemails enable row level security;
revoke all on public.voice_workspaces,public.voice_queues,public.voice_agents,public.voice_flows,public.voice_voicemails from public,anon,authenticated;
grant all on public.voice_workspaces,public.voice_queues,public.voice_agents,public.voice_flows,public.voice_voicemails to service_role;

-- A durable lease serializes provider configuration across API replicas.
create function public.voice_center_lock(p_org_id uuid,p_actor_id uuid,p_token uuid,p_release boolean default false)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform private.require_admin(p_org_id,p_actor_id);
  if p_release then
    update public.voice_workspaces set lock_token=null,locked_until=null where organization_id=p_org_id and lock_token=p_token;
    return found;
  end if;
  insert into public.voice_workspaces(organization_id) values(p_org_id) on conflict do nothing;
  update public.voice_workspaces set lock_token=p_token,locked_until=now()+interval '5 minutes'
    where organization_id=p_org_id and (lock_token is null or locked_until<now());
  return found;
end; $$;

create function public.voice_flow_save(p_org_id uuid,p_actor_id uuid,p_line_id uuid,p_config jsonb,p_version integer,p_publish boolean)
returns integer language plpgsql security definer set search_path='' as $$
declare v_version integer; v_target jsonb; v_queue_id uuid;
begin
  perform private.require_admin(p_org_id,p_actor_id);
  perform 1 from public.lines where organization_id=p_org_id and id=p_line_id and status='active' and voice_enabled for update;
  if not found then raise exception 'Voice line unavailable' using errcode='P0002'; end if;
  select version into v_version from public.voice_flows where line_id=p_line_id and organization_id=p_org_id;
  if coalesce(v_version,0)<>p_version then raise exception 'Stale flow' using errcode='40001'; end if;
  if p_config is null or jsonb_typeof(p_config)<>'object' or jsonb_typeof(p_config->'enabled')<>'boolean' or jsonb_typeof(p_config->'menus')<>'array' then raise exception 'Invalid flow' using errcode='22023'; end if;
  -- Validate all queue references against the same organization AND line, even in drafts.
  for v_target in select value from jsonb_path_query(p_config,'$.** ? (@.type == "queue")') as value loop
    v_queue_id := (v_target->>'queueId')::uuid;
    if not exists(select 1 from public.voice_queues where organization_id=p_org_id and line_id=p_line_id and id=v_queue_id and (not p_publish or (workflow_sid is not null and synced_version=version))) then
      raise exception 'Queue unavailable on this line' using errcode='23503';
    end if;
  end loop;
  insert into public.voice_flows(organization_id,line_id,draft,published,version,published_at)
    values(p_org_id,p_line_id,p_config,case when p_publish then p_config end,1,case when p_publish then now() end)
    on conflict(line_id) do update set draft=excluded.draft,version=voice_flows.version+1,
      published=case when p_publish then excluded.draft else voice_flows.published end,
      published_at=case when p_publish then now() else voice_flows.published_at end
    returning version into v_version;
  -- Publishing supersedes the old editor. Disabling this flow returns to direct ringing.
  if p_publish then update public.lines set ivr_config=jsonb_set(ivr_config,'{enabled}','false') where id=p_line_id; end if;
  insert into public.audit_events(organization_id,actor_user_id,action,target_type,target_id,outcome)
    values(p_org_id,p_actor_id,case when p_publish then 'voice_flow.publish' else 'voice_flow.save' end,'line',p_line_id,'allowed');
  return v_version;
end; $$;

alter function public.begin_inbound_call(text,text,text,text,integer) rename to begin_inbound_call_legacy;
create function public.begin_inbound_call(p_account_sid text,p_call_sid text,p_from text,p_to text,p_max_ringing_devices integer default 4)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_line public.lines%rowtype; v_config jsonb; v_call public.calls%rowtype;
begin
  if p_account_sid is null or p_call_sid is null or p_call_sid !~ '^CA[0-9a-fA-F]{32}$' or p_from is null or p_from !~ '^\+[1-9][0-9]{7,14}$' or p_to is null or p_to !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Invalid inbound payload' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_account_sid||':'||p_call_sid,0));
  select l.* into v_line from public.lines l join public.organizations o on o.id=l.organization_id
    where l.twilio_account_sid=p_account_sid and l.phone_number=p_to and l.status='active' and l.voice_enabled and o.status='active';
  if found then
    select c.* into v_call from public.calls c join public.call_legs leg on leg.call_id=c.id where leg.provider_call_sid=p_call_sid and c.organization_id=v_line.organization_id;
    if v_call.id is not null and v_call.ivr_state->>'engine'='taskrouter' then
      if v_call.ended_at is not null then return jsonb_build_object('allowed',true,'hangup',true); end if;
      return jsonb_build_object('allowed',true,'callId',v_call.id,'organizationId',v_line.organization_id,'lineId',v_line.id,'flow',v_call.ivr_state->'config');
    end if;
    select published into v_config from public.voice_flows where line_id=v_line.id and organization_id=v_line.organization_id;
    if v_call.id is null and coalesce((v_config->>'enabled')::boolean,false) then
      insert into public.calls(organization_id,line_id,direction,remote_number,status,started_at,ivr_state)
        values(v_line.organization_id,v_line.id,'inbound',p_from,'ringing',now(),jsonb_build_object('engine','taskrouter','config',v_config)) returning * into v_call;
      insert into public.call_legs(organization_id,call_id,provider_call_sid,status,started_at) values(v_line.organization_id,v_call.id,p_call_sid,'ringing',now());
      return jsonb_build_object('allowed',true,'callId',v_call.id,'organizationId',v_line.organization_id,'lineId',v_line.id,'flow',v_config);
    end if;
  end if;
  return public.begin_inbound_call_legacy(p_account_sid,p_call_sid,p_from,p_to,p_max_ringing_devices);
end; $$;

alter table public.call_reservations add column routing_reservation_sid text;

-- Assignment validates membership, line permissions, fresh device presence, and
-- the global reservation in ONE transaction (also excludes direct/outbound calls).
create function public.voice_reserve_agent(p_org_id uuid,p_user_id uuid,p_call_id uuid,p_seconds integer,p_reservation_sid text)
returns text language plpgsql security definer set search_path='' as $$
declare v_line_id uuid; v_identity text; v_id uuid;
begin
  if p_reservation_sid is null or p_reservation_sid !~ '^WR[0-9a-fA-F]{32}$' then raise exception 'Invalid reservation' using errcode='22023'; end if;
  select line_id into v_line_id from public.calls where organization_id=p_org_id and id=p_call_id and ended_at is null;
  if not found or not exists(select 1 from public.line_assignments a join public.memberships m using(organization_id,user_id) where a.organization_id=p_org_id and a.line_id=v_line_id and a.user_id=p_user_id and a.status='active' and a.can_voice and m.status='active') then return null; end if;
  select coalesce(a.contact_number,'client:'||d.voice_identity) into v_identity from public.voice_agents a
    left join lateral(select voice_identity from public.devices where organization_id=p_org_id and user_id=p_user_id and status='active' and voice_registered_at is not null and (platform in ('ios','android') or voice_registered_at>now()-interval '90 seconds') order by last_active_at desc nulls last limit 1) d on true
    where a.organization_id=p_org_id and a.user_id=p_user_id;
  if v_identity is null then return null; end if;
  update public.call_reservations set status='expired' where user_id=p_user_id and status in ('preparing','active') and expires_at<=now();
  insert into public.call_reservations(organization_id,user_id,call_id,status,expires_at,routing_reservation_sid)
    values(p_org_id,p_user_id,p_call_id,'active',now()+make_interval(secs=>greatest(5,least(p_seconds,3600))),p_reservation_sid)
    on conflict(user_id) where status in ('preparing','active') do nothing returning id into v_id;
  if v_id is null and not exists(select 1 from public.call_reservations where user_id=p_user_id and call_id=p_call_id and status='active' and expires_at>now() and routing_reservation_sid=p_reservation_sid) then return null; end if;
  return v_identity;
end; $$;
revoke all on function public.voice_center_lock(uuid,uuid,uuid,boolean),public.voice_flow_save(uuid,uuid,uuid,jsonb,integer,boolean),public.begin_inbound_call(text,text,text,text,integer),public.voice_reserve_agent(uuid,uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.voice_center_lock(uuid,uuid,uuid,boolean),public.voice_flow_save(uuid,uuid,uuid,jsonb,integer,boolean),public.begin_inbound_call(text,text,text,text,integer),public.voice_reserve_agent(uuid,uuid,uuid,integer,text) to service_role;

-- An IVR answering the PSTN leg is not an agent answering the caller. Preserve
-- this distinction for callbacks and the existing reconciliation worker.
alter function public.apply_call_status(text,text,text,text,integer,timestamptz,integer) rename to apply_call_status_legacy;
create function public.apply_call_status(p_account_sid text,p_call_sid text,p_parent_call_sid text,p_call_status text,p_call_duration integer,p_provider_event_at timestamptz,p_provider_sequence_number integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_call public.calls%rowtype; v_terminal boolean;
begin
  select c.* into v_call from public.calls c join public.call_legs leg on leg.call_id=c.id join public.lines l on l.id=c.line_id
    where leg.provider_call_sid=p_call_sid and l.twilio_account_sid=p_account_sid and c.ivr_state->>'engine'='taskrouter' for update of c;
  if not found then return public.apply_call_status_legacy(p_account_sid,p_call_sid,p_parent_call_sid,p_call_status,p_call_duration,p_provider_event_at,p_provider_sequence_number); end if;
  if p_call_status is null or p_call_status not in ('initiated','ringing','in-progress','completed','busy','no-answer','canceled','failed') or p_call_duration<0 then raise exception 'Invalid call status' using errcode='22023'; end if;
  v_terminal := p_call_status in ('completed','busy','no-answer','canceled','failed');
  update public.call_legs set status=case when v_terminal then 'completed' else status end,
    ended_at=case when v_terminal then coalesce(ended_at,now()) else ended_at end
    where provider_call_sid=p_call_sid;
  if v_terminal and v_call.ended_at is null then
    update public.calls set status=case when answered_at is not null then 'completed' else 'missed' end,ended_at=now(),
      duration_seconds=case when answered_at is not null then greatest(0,extract(epoch from now()-answered_at)::integer) else 0 end
      where id=v_call.id;
    update public.call_reservations set status='released',expires_at=now() where call_id=v_call.id and status='active';
  end if;
  return jsonb_build_object('callId',v_call.id,'ignored',not v_terminal,'duplicate',v_call.ended_at is not null);
end; $$;
revoke all on function public.apply_call_status(text,text,text,text,integer,timestamptz,integer) from public,anon,authenticated;
grant execute on function public.apply_call_status(text,text,text,text,integer,timestamptz,integer) to service_role;
