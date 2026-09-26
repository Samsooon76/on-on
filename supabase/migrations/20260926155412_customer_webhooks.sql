-- Customer webhooks: transactionally recorded events, isolated subscriptions and leased delivery.
create table public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  created_by uuid not null references auth.users(id),
  description text not null check(length(description) between 1 and 120),
  url text not null check(length(url)<=2048 and url like 'https://%'),
  events text[] not null check(cardinality(events) between 1 and 12 and events <@ array['sms.received','sms.sent','sms.delivered','sms.failed','call.received','call.started','call.connected','call.ended','call.missed','voicemail.received','user.status_changed','user.reachability_changed']),
  secret_ciphertext text not null,
  enabled boolean not null default true,
  deleted_at timestamptz,
  last_test_at timestamptz,
  created_at timestamptz not null default now(),
  unique(organization_id,id)
);
create index webhook_endpoints_org on public.webhook_endpoints(organization_id) where deleted_at is null;
create index webhook_endpoints_creator on public.webhook_endpoints(created_by);
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique(organization_id,id)
);
create index webhook_events_retention on public.webhook_events(created_at);
create table public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  endpoint_id uuid not null,
  event_id uuid not null,
  status text not null default 'pending' check(status in ('pending','sending','delivered','failed','canceled')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  locked_until timestamptz,
  http_status integer,
  last_error text,
  delivered_at timestamptz,
  last_replay_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key(organization_id,endpoint_id) references public.webhook_endpoints(organization_id,id),
  foreign key(organization_id,event_id) references public.webhook_events(organization_id,id) on delete cascade,
  unique(endpoint_id,event_id)
);
create index webhook_deliveries_due on public.webhook_deliveries(next_attempt_at) where status in ('pending','sending');
create index webhook_deliveries_endpoint on public.webhook_deliveries(organization_id,endpoint_id,created_at desc);
create index webhook_deliveries_event on public.webhook_deliveries(organization_id,event_id);
create table public.webhook_user_reachability (
  organization_id uuid not null,
  user_id uuid not null,
  status text not null check(status in ('available','busy','offline')),
  primary key(organization_id,user_id),
  foreign key(organization_id,user_id) references public.memberships(organization_id,user_id) on delete cascade
);
alter table public.webhook_endpoints enable row level security;
alter table public.webhook_events enable row level security;
alter table public.webhook_deliveries enable row level security;
alter table public.webhook_user_reachability enable row level security;
revoke all on public.webhook_endpoints,public.webhook_events,public.webhook_deliveries,public.webhook_user_reachability from public,anon,authenticated;
grant all on public.webhook_endpoints,public.webhook_events,public.webhook_deliveries,public.webhook_user_reachability to service_role;

-- Only internal triggers and service RPCs can enqueue. No network work in transactions.
create function private.enqueue_customer_webhook(p_org uuid,p_type text,p_data jsonb,p_endpoint uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare event_id uuid:=gen_random_uuid(); destinations uuid[];
begin
  select array_agg(e.id) into destinations from public.webhook_endpoints e
    join public.memberships m on m.organization_id=e.organization_id and m.user_id=e.created_by and m.status='active' and m.role='admin'
    join public.organizations o on o.id=e.organization_id and o.status='active'
    where e.organization_id=p_org and e.enabled and e.deleted_at is null
      and ((p_endpoint is null and p_type=any(e.events)) or (p_type='webhook.test' and e.id=p_endpoint));
  if destinations is null then return null; end if;
  insert into public.webhook_events(id,organization_id,event_type,payload) values(event_id,p_org,p_type,
    jsonb_build_object('id',event_id,'type',p_type,'apiVersion','v1','createdAt',now(),'organizationId',p_org,'data',p_data));
  insert into public.webhook_deliveries(organization_id,endpoint_id,event_id) select p_org,unnest(destinations),event_id;
  return event_id;
end; $$;

create function private.capture_customer_webhook()
returns trigger language plpgsql security definer set search_path='' as $$
declare data jsonb; line_id uuid; remote text; old_status text; old_role text;
begin
  if tg_table_name='messages' then
    if tg_op='UPDATE' and new.status is not distinct from old.status then return new; end if;
    select c.line_id,c.remote_number into line_id,remote from public.conversations c where c.id=new.conversation_id;
    data:=jsonb_build_object('id',new.id,'conversationId',new.conversation_id,'lineId',line_id,'remoteNumber',remote,'direction',new.direction,'body',new.body,'status',new.status,'createdAt',new.created_at,'sentAt',new.sent_at,'deliveredAt',new.delivered_at,'errorCode',new.provider_error_code);
    if new.direction='inbound' and new.status='received' then perform private.enqueue_customer_webhook(new.organization_id,'sms.received',data);
    elsif new.direction='outbound' and new.status in ('sent','delivered','failed','undelivered') then
      perform private.enqueue_customer_webhook(new.organization_id,case when new.status in ('failed','undelivered') then 'sms.failed' else 'sms.'||new.status end,data);
    end if;
  elsif tg_table_name='calls' then
    data:=jsonb_build_object('id',new.id,'lineId',new.line_id,'direction',new.direction,'remoteNumber',new.remote_number,'status',new.status,'startedAt',new.started_at,'answeredAt',new.answered_at,'endedAt',new.ended_at,'durationSeconds',new.duration_seconds);
    if tg_op='INSERT' then perform private.enqueue_customer_webhook(new.organization_id,case when new.direction='inbound' then 'call.received' else 'call.started' end,data); end if;
    if new.answered_at is not null and (tg_op='INSERT' or old.answered_at is null) then perform private.enqueue_customer_webhook(new.organization_id,'call.connected',data); end if;
    if new.ended_at is not null and (tg_op='INSERT' or old.ended_at is null) then
      perform private.enqueue_customer_webhook(new.organization_id,'call.ended',data);
      if new.direction='inbound' and new.answered_at is null then perform private.enqueue_customer_webhook(new.organization_id,'call.missed',data); end if;
    end if;
  elsif tg_table_name='memberships' then
    if tg_op='UPDATE' then old_status:=old.status; old_role:=old.role; end if;
    if tg_op='INSERT' or new.status is distinct from old_status or new.role is distinct from old_role then
      perform private.enqueue_customer_webhook(new.organization_id,'user.status_changed',jsonb_build_object('userId',new.user_id,'status',new.status,'previousStatus',old_status,'role',new.role,'previousRole',old_role));
    end if;
  elsif tg_table_name='voice_voicemails' then
    select c.line_id into line_id from public.calls c where c.id=new.call_id;
    perform private.enqueue_customer_webhook(new.organization_id,'voicemail.received',jsonb_build_object('id',new.id,'callId',new.call_id,'lineId',line_id,'durationSeconds',new.duration,'createdAt',new.created_at));
  end if;
  return new;
end; $$;
create trigger customer_message_event after insert or update of status on public.messages for each row execute function private.capture_customer_webhook();
create trigger customer_call_event after insert or update of answered_at,ended_at on public.calls for each row execute function private.capture_customer_webhook();
create trigger customer_member_event after insert or update of status,role on public.memberships for each row execute function private.capture_customer_webhook();
create trigger customer_voicemail_event after insert on public.voice_voicemails for each row execute function private.capture_customer_webhook();

-- Sample aggregate application reachability, including silent browser expiry. The
-- initial sample is a baseline; subsequent changes are events, never heartbeats.
create function public.refresh_webhook_reachability()
returns void language plpgsql security definer set search_path='' as $$
declare member record; previous text;
begin
  if not pg_try_advisory_xact_lock(714235901) then return; end if;
  for member in
    select m.organization_id,m.user_id,case when m.status<>'active' then 'offline'
      when exists(select 1 from public.call_reservations r where r.organization_id=m.organization_id and r.user_id=m.user_id and r.status in ('preparing','active') and r.expires_at>now()) then 'busy'
      when exists(select 1 from public.devices d where d.organization_id=m.organization_id and d.user_id=m.user_id and d.status='active' and d.voice_registered_at is not null and (d.platform in ('ios','android') or d.voice_registered_at>now()-interval '90 seconds')) then 'available'
      else 'offline' end as state
    from public.memberships m where exists(select 1 from public.webhook_endpoints e where e.organization_id=m.organization_id and e.enabled and e.deleted_at is null and 'user.reachability_changed'=any(e.events))
  loop
    select status into previous from public.webhook_user_reachability where organization_id=member.organization_id and user_id=member.user_id;
    if previous is not null and previous<>member.state then perform private.enqueue_customer_webhook(member.organization_id,'user.reachability_changed',jsonb_build_object('userId',member.user_id,'status',member.state,'previousStatus',previous)); end if;
    insert into public.webhook_user_reachability values(member.organization_id,member.user_id,member.state)
      on conflict(organization_id,user_id) do update set status=excluded.status where webhook_user_reachability.status is distinct from excluded.status;
  end loop;
end; $$;

create function public.manage_customer_webhook(p_org uuid,p_actor uuid,p_action text,p_id uuid,p_input jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare endpoint public.webhook_endpoints; result jsonb; delivery public.webhook_deliveries;
begin
  perform private.require_admin(p_org,p_actor);
  -- Serialize creation/quota checks and administrative edits for this tenant.
  perform 1 from public.organizations where id=p_org for update;
  if p_action='create' then
    if (select count(*) from public.webhook_endpoints where organization_id=p_org and deleted_at is null)>=10 then raise exception 'Webhook limit reached' using errcode='54000'; end if;
    insert into public.webhook_endpoints(id,organization_id,created_by,description,url,events,secret_ciphertext)
      values(p_id,p_org,p_actor,p_input->>'description',p_input->>'url',array(select jsonb_array_elements_text(p_input->'events')),p_input->>'secretCiphertext') returning * into endpoint;
  else
    select * into endpoint from public.webhook_endpoints where id=p_id and organization_id=p_org and deleted_at is null for update;
    if not found then raise exception 'Webhook not found' using errcode='P0002'; end if;
    if p_action='enabled' then
      update public.webhook_endpoints set enabled=(p_input->>'enabled')::boolean where id=p_id returning * into endpoint;
    elsif p_action='delete' then
      update public.webhook_endpoints set enabled=false,deleted_at=now() where id=p_id returning * into endpoint;
    elsif p_action='rotate' then
      update public.webhook_endpoints set secret_ciphertext=p_input->>'secretCiphertext' where id=p_id returning * into endpoint;
    elsif p_action='test' then
      if not endpoint.enabled then raise exception 'Webhook disabled' using errcode='22023'; end if;
      if endpoint.last_test_at>now()-interval '1 minute' then raise exception 'Test rate limit' using errcode='54000'; end if;
      update public.webhook_endpoints set last_test_at=now() where id=p_id;
      result:=jsonb_build_object('eventId',private.enqueue_customer_webhook(p_org,'webhook.test',jsonb_build_object('message','Test de votre webhook Onoff.'),p_id));
      if result->>'eventId' is null then raise exception 'Creator access revoked' using errcode='42501'; end if;
    elsif p_action='replay' then
      select * into delivery from public.webhook_deliveries where id=(p_input->>'deliveryId')::uuid and organization_id=p_org and endpoint_id=p_id for update;
      if not found then raise exception 'Delivery not found' using errcode='P0002'; end if;
      if not endpoint.enabled or delivery.status<>'failed' then raise exception 'Only failed deliveries may be retried' using errcode='22023'; end if;
      if delivery.last_replay_at>now()-interval '1 minute' then raise exception 'Replay rate limit' using errcode='54000'; end if;
      update public.webhook_deliveries set status='pending',attempts=0,next_attempt_at=now(),lease_token=null,locked_until=null,last_replay_at=now(),last_error=null where id=delivery.id;
      result:=jsonb_build_object('eventId',delivery.event_id);
    else raise exception 'Unknown action' using errcode='22023'; end if;
    if not endpoint.enabled then
      update public.webhook_deliveries set status='canceled',lease_token=null,locked_until=null where endpoint_id=p_id and status in ('pending','sending');
    end if;
  end if;
  insert into public.audit_events(organization_id,actor_user_id,action,target_type,target_id,outcome) values(p_org,p_actor,'webhook.'||p_action,'webhook',p_id,'allowed');
  return coalesce(result,to_jsonb(endpoint)-'secret_ciphertext');
end; $$;

create function public.claim_customer_webhooks(p_limit integer default 4)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  update public.webhook_deliveries d set status='canceled',lease_token=null,locked_until=null
    where status in ('pending','sending') and not exists(select 1 from public.webhook_endpoints e
      join public.memberships m on m.organization_id=e.organization_id and m.user_id=e.created_by and m.role='admin' and m.status='active'
      join public.organizations o on o.id=e.organization_id and o.status='active'
      where e.id=d.endpoint_id and e.enabled and e.deleted_at is null);
  update public.webhook_deliveries set status='failed',last_error='lease_expired',lease_token=null,locked_until=null
    where status='sending' and locked_until<now() and attempts>=8;
  with candidates as (
    select id from public.webhook_deliveries where attempts<8 and next_attempt_at<=now()
      and (status='pending' or (status='sending' and locked_until<now()))
      order by next_attempt_at,id limit greatest(1,least(p_limit,20)) for update skip locked
  ), claimed as (
    update public.webhook_deliveries d set status='sending',attempts=d.attempts+1,lease_token=gen_random_uuid(),locked_until=now()+interval '60 seconds'
      from candidates c where c.id=d.id returning d.*
  ) select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'leaseToken',c.lease_token,'attempt',c.attempts,'url',e.url,'secretCiphertext',e.secret_ciphertext,'payload',v.payload)),'[]') into result
    from claimed c join public.webhook_endpoints e on e.id=c.endpoint_id join public.webhook_events v on v.id=c.event_id;
  return result;
end; $$;

create function public.finish_customer_webhook(p_id uuid,p_lease uuid,p_http_status integer,p_error text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  update public.webhook_deliveries set http_status=p_http_status,
    status=case when p_http_status between 200 and 299 then 'delivered' when attempts>=8 then 'failed' else 'pending' end,
    delivered_at=case when p_http_status between 200 and 299 then now() end,
    last_error=case when p_http_status between 200 and 299 then null else left(p_error,80) end,
    next_attempt_at=now()+make_interval(secs=>(array[30,120,600,1800,7200,21600,86400,86400])[least(attempts,8)]),
    lease_token=null,locked_until=null
    where id=p_id and lease_token=p_lease and status='sending';
  return found;
end; $$;
create function public.prune_customer_webhooks()
returns void language sql security definer set search_path='' as $$
  delete from public.webhook_events where created_at<now()-interval '7 days';
$$;
revoke all on function private.enqueue_customer_webhook(uuid,text,jsonb,uuid),private.capture_customer_webhook() from public,anon,authenticated;
revoke all on function public.manage_customer_webhook(uuid,uuid,text,uuid,jsonb),public.claim_customer_webhooks(integer),public.finish_customer_webhook(uuid,uuid,integer,text),public.refresh_webhook_reachability(),public.prune_customer_webhooks() from public,anon,authenticated;
grant execute on function public.manage_customer_webhook(uuid,uuid,text,uuid,jsonb),public.claim_customer_webhooks(integer),public.finish_customer_webhook(uuid,uuid,integer,text),public.refresh_webhook_reachability(),public.prune_customer_webhooks() to service_role;
