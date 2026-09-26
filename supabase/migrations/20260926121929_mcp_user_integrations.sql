-- OAuth tokens use an isolated role: no inheritance from authenticated, no
-- mutation/RPC/Realtime access. All writes enter service-only, scoped functions.
create role onoff_mcp nologin noinherit;
grant onoff_mcp to authenticator;
grant usage on schema public, auth, private to onoff_mcp;
grant execute on function auth.uid() to onoff_mcp;

create table public.mcp_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null check (length(client_id) between 1 and 200),
  client_name text not null check (length(client_name) between 1 and 120),
  organization_id uuid not null references public.organizations(id),
  line_ids uuid[] not null default '{}',
  permissions text[] not null check (cardinality(permissions) between 1 and 6 and permissions <@ array['contacts:read','messages:read','calls:read','contacts:write','messages:send','calls:prepare']),
  resource_url text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
create unique index mcp_grants_active_client on public.mcp_grants(user_id,client_id) where revoked_at is null;
create index mcp_grants_user on public.mcp_grants(user_id,created_at desc);

-- Bind refreshes to the OAuth session, not to custom claims from a previous
-- access token: Auth reconstructs the hook input when refreshing a token.
create table public.mcp_oauth_sessions (
  session_id uuid primary key,
  grant_id uuid not null references public.mcp_grants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  created_at timestamptz not null default now()
);
create index mcp_oauth_sessions_grant on public.mcp_oauth_sessions(grant_id);
create table public.mcp_contact_actions (
  grant_id uuid not null references public.mcp_grants(id) on delete cascade,
  request_key uuid not null,
  payload jsonb not null,
  result_id uuid not null,
  created_at timestamptz not null default now(),
  primary key(grant_id,request_key)
);
create table public.mcp_sms_drafts (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references public.mcp_grants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id),
  line_id uuid not null references public.lines(id),
  destination text not null check (destination ~ '^\+[1-9][0-9]{7,14}$'),
  body text not null check (length(btrim(body)) between 1 and 1600),
  request_key uuid not null,
  state text not null default 'pending' check (state in ('pending','approved','rejected','submitted')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  approved_at timestamptz,
  message_id uuid references public.messages(id),
  unique(grant_id, request_key)
);
create index mcp_sms_drafts_user on public.mcp_sms_drafts(user_id,created_at desc);
create table public.mcp_audit_events (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references public.mcp_grants(id) on delete cascade,
  tool text not null,
  outcome text not null check (outcome in ('ok','error')),
  request_id uuid not null,
  created_at timestamptz not null default now()
);
create index mcp_audit_grant_date on public.mcp_audit_events(grant_id,created_at desc);
alter table public.mcp_grants enable row level security;
alter table public.mcp_oauth_sessions enable row level security;
alter table public.mcp_contact_actions enable row level security;
alter table public.mcp_sms_drafts enable row level security;
alter table public.mcp_audit_events enable row level security;
revoke all on public.mcp_grants,public.mcp_oauth_sessions,public.mcp_contact_actions,public.mcp_sms_drafts,public.mcp_audit_events from public,anon,authenticated,onoff_mcp;
grant all on public.mcp_grants,public.mcp_oauth_sessions,public.mcp_contact_actions,public.mcp_sms_drafts,public.mcp_audit_events to service_role;

-- This gate is also evaluated for direct Data API requests. Claims must bind
-- the current grant, client, user AND resource, and membership is re-read.
create function private.mcp_can(p_org uuid, p_permission text default null, p_line uuid default null)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.mcp_grants g
    join public.memberships m on m.organization_id=g.organization_id and m.user_id=g.user_id and m.status='active'
    join public.organizations o on o.id=g.organization_id and o.status='active'
    where g.id::text = (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'mcp_grant_id')
      and g.user_id=auth.uid() and g.organization_id=p_org and g.revoked_at is null
      and g.client_id=(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'client_id')
      and g.resource_url=(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'aud')
      and (p_permission is null or p_permission=any(g.permissions))
      and (p_line is null or (p_line=any(g.line_ids) and exists (
        select 1 from public.line_assignments a join public.lines l on l.id=a.line_id and l.organization_id=a.organization_id
        where a.line_id=p_line and a.organization_id=p_org and a.user_id=g.user_id and a.status='active' and l.status='active'
          and case when p_permission in ('calls:read','calls:prepare') then a.can_voice and l.voice_enabled
                   when p_permission in ('messages:read','messages:send') then a.can_sms and l.sms_enabled
                   else a.can_voice or a.can_sms end
      )))
  )
$$;
revoke all on function private.mcp_can(uuid,text,uuid) from public,anon,authenticated;
grant execute on function private.mcp_can(uuid,text,uuid) to onoff_mcp;

grant select(id,name,status) on public.organizations to onoff_mcp;
grant select(organization_id,user_id,role,status) on public.memberships to onoff_mcp;
grant select(id,organization_id,phone_number,voice_enabled,sms_enabled,status) on public.lines to onoff_mcp;
grant select(organization_id,line_id,user_id,can_voice,can_sms,status) on public.line_assignments to onoff_mcp;
grant select(id,organization_id,display_name,email,version,created_at,archived_at) on public.contacts to onoff_mcp;
grant select(id,organization_id,contact_id,phone_number,label) on public.contact_phones to onoff_mcp;
grant select(id,organization_id,line_id,direction,remote_number,status,started_at,answered_at,ended_at,duration_seconds,created_at) on public.calls to onoff_mcp;
grant select(id,organization_id,line_id,remote_number,last_message_at) on public.conversations to onoff_mcp;
grant select(id,organization_id,conversation_id,direction,body,status,created_at,sent_at,delivered_at) on public.messages to onoff_mcp;
create policy mcp_organizations on public.organizations for select to onoff_mcp using (private.mcp_can(id));
create policy mcp_memberships on public.memberships for select to onoff_mcp using (user_id=auth.uid() and status='active' and private.mcp_can(organization_id));
create policy mcp_lines on public.lines for select to onoff_mcp using (private.mcp_can(organization_id,null,id));
create policy mcp_assignments on public.line_assignments for select to onoff_mcp using (user_id=auth.uid() and status='active' and private.mcp_can(organization_id,null,line_id));
create policy mcp_contacts on public.contacts for select to onoff_mcp using (archived_at is null and private.mcp_can(organization_id,'contacts:read'));
create policy mcp_contact_phones on public.contact_phones for select to onoff_mcp using (private.mcp_can(organization_id,'contacts:read') and exists(select 1 from public.contacts c where c.id=contact_id and c.archived_at is null));
create policy mcp_calls on public.calls for select to onoff_mcp using (private.mcp_can(organization_id,'calls:read',line_id));
create policy mcp_conversations on public.conversations for select to onoff_mcp using (private.mcp_can(organization_id,'messages:read',line_id));
create policy mcp_messages on public.messages for select to onoff_mcp using (exists(select 1 from public.conversations c where c.id=conversation_id and c.organization_id=messages.organization_id and private.mcp_can(c.organization_id,'messages:read',c.line_id)));

-- Configure this hook in Supabase Auth before enabling OAuth/MCP. Non-OAuth
-- sessions keep their original role. A refreshed token cannot adopt a new grant.
create function public.onoff_mcp_access_token_hook(event jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c jsonb := event->'claims'; g public.mcp_grants; cid text := event->'claims'->>'client_id'; sid uuid; uid uuid := (event->>'user_id')::uuid;
begin
  if nullif(cid,'') is null then return event; end if;
  sid := (c->>'session_id')::uuid;
  if sid is null or (c->>'sub') is distinct from uid::text then raise exception 'OAuth session required' using errcode='42501'; end if;
  if event->>'authentication_method'='oauth_provider/authorization_code' then
    select * into g from public.mcp_grants where user_id=uid and client_id=cid and revoked_at is null;
    if not found then raise exception 'Onoff integration consent required' using errcode='42501'; end if;
    insert into public.mcp_oauth_sessions(session_id,grant_id,user_id,client_id) values(sid,g.id,uid,cid) on conflict(session_id) do nothing;
  end if;
  select grants.* into g from public.mcp_grants grants join public.mcp_oauth_sessions sessions on sessions.grant_id=grants.id
    where sessions.session_id=sid and sessions.user_id=uid and sessions.client_id=cid
      and grants.user_id=uid and grants.client_id=cid and grants.revoked_at is null;
  if not found then raise exception 'Onoff integration consent required' using errcode='42501'; end if;
  c := jsonb_set(c,'{role}','"onoff_mcp"');
  c := jsonb_set(c,'{aud}',to_jsonb(g.resource_url));
  c := jsonb_set(c,'{mcp_grant_id}',to_jsonb(g.id::text));
  return jsonb_set(event,'{claims}',c);
end;
$$;

revoke all on function public.onoff_mcp_access_token_hook(jsonb) from public,anon,authenticated,onoff_mcp;
grant execute on function public.onoff_mcp_access_token_hook(jsonb) to supabase_auth_admin;

create function private.require_mcp_grant(p_user uuid,p_grant uuid,p_permission text default null,p_line uuid default null)
returns public.mcp_grants language plpgsql security definer set search_path = '' as $$
declare g public.mcp_grants;
begin
  select * into g from public.mcp_grants where id=p_grant and user_id=p_user and revoked_at is null for update;
  if not found or not exists(select 1 from public.memberships m join public.organizations o on o.id=m.organization_id where m.organization_id=g.organization_id and m.user_id=p_user and m.status='active' and o.status='active')
    or (p_permission is not null and not p_permission=any(g.permissions)) then
    raise exception 'integration access denied' using errcode='42501';
  end if;
  if p_line is not null and (not p_line=any(g.line_ids) or not exists(
    select 1 from public.line_assignments a join public.lines l on l.id=a.line_id and l.organization_id=a.organization_id
    where a.organization_id=g.organization_id and a.line_id=p_line and a.user_id=p_user and a.status='active' and l.status='active'
      and case when p_permission in ('calls:read','calls:prepare') then a.can_voice and l.voice_enabled
               when p_permission in ('messages:read','messages:send') then a.can_sms and l.sms_enabled
               else a.can_voice or a.can_sms end
  )) then raise exception 'line access denied' using errcode='42501'; end if;
  return g;
end;
$$;
revoke all on function private.require_mcp_grant(uuid,uuid,text,uuid) from public,anon,authenticated,onoff_mcp;

create function public.mcp_create_grant(p_user uuid,p_client text,p_name text,p_org uuid,p_lines uuid[],p_permissions text[],p_resource text)
returns public.mcp_grants language plpgsql security definer set search_path = '' as $$
declare g public.mcp_grants;
begin
  if not exists(select 1 from public.memberships m join public.organizations o on o.id=m.organization_id where m.organization_id=p_org and m.user_id=p_user and m.status='active' and o.status='active')
    or exists(select 1 from unnest(p_lines) as requested(line_id) where not exists(select 1 from public.line_assignments a join public.lines l on l.id=a.line_id where a.line_id=requested.line_id and a.organization_id=p_org and a.user_id=p_user and a.status='active' and (a.can_voice or a.can_sms) and l.status='active'))
    then raise exception 'integration access denied' using errcode='42501'; end if;
  if cardinality(p_lines)>100 or (('contacts:write'=any(p_permissions)) and not 'contacts:read'=any(p_permissions)) then raise exception 'invalid permissions' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user::text||':'||p_client,0));
  update public.mcp_grants set revoked_at=now() where user_id=p_user and client_id=p_client and revoked_at is null;
  insert into public.mcp_grants(user_id,client_id,client_name,organization_id,line_ids,permissions,resource_url)
    values(p_user,p_client,p_name,p_org,p_lines,p_permissions,p_resource) returning * into g;
  return g;
end;
$$;

create function public.mcp_write_contact(p_user uuid,p_grant uuid,p_key uuid,p_payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare g public.mcp_grants; existing public.mcp_contact_actions; result uuid; prior text := current_setting('request.jwt.claim.sub',true);
begin
  g := private.require_mcp_grant(p_user,p_grant,'contacts:write');
  select * into existing from public.mcp_contact_actions where grant_id=p_grant and request_key=p_key;
  if found then
    if existing.payload is distinct from p_payload then raise exception 'idempotency conflict' using errcode='22023'; end if;
    return existing.result_id;
  end if;
  perform set_config('request.jwt.claim.sub',p_user::text,true);
  if p_payload->>'id' is null then
    result := public.create_contact_with_phones(g.organization_id,p_payload->>'displayName',p_payload->>'email',p_payload->'phones');
  else
    if not exists(select 1 from public.contacts where id=(p_payload->>'id')::uuid and organization_id=g.organization_id and archived_at is null) then raise exception 'contact not found' using errcode='P0002'; end if;
    result := public.update_contact_with_phones((p_payload->>'id')::uuid,g.organization_id,p_payload->>'displayName',p_payload->>'email',(p_payload->>'version')::integer,p_payload->'phones');
    if result is null then raise exception 'contact version conflict' using errcode='40001'; end if;
  end if;
  perform set_config('request.jwt.claim.sub',coalesce(prior,''),true);
  insert into public.mcp_contact_actions values(p_grant,p_key,p_payload,result,now());
  return result;
end;
$$;

create function public.mcp_create_sms_draft(p_user uuid,p_grant uuid,p_key uuid,p_line uuid,p_destination text,p_body text)
returns public.mcp_sms_drafts language plpgsql security definer set search_path = '' as $$
declare g public.mcp_grants; d public.mcp_sms_drafts;
begin
  g := private.require_mcp_grant(p_user,p_grant,'messages:send',p_line);
  select * into d from public.mcp_sms_drafts where grant_id=p_grant and request_key=p_key;
  if found then
    if d.line_id is distinct from p_line or d.destination is distinct from p_destination or d.body is distinct from p_body then raise exception 'idempotency conflict' using errcode='22023'; end if;
    return d;
  end if;
  if (select count(*) from public.mcp_sms_drafts where user_id=p_user and created_at>now()-interval '1 hour') >= 100 then raise exception 'draft rate limit' using errcode='54000'; end if;
  insert into public.mcp_sms_drafts(grant_id,user_id,organization_id,line_id,destination,body,request_key)
    values(p_grant,p_user,g.organization_id,p_line,p_destination,p_body,p_key) returning * into d;
  return d;
end;
$$;

create function public.mcp_decide_sms(p_user uuid,p_draft uuid,p_approve boolean)
returns public.mcp_sms_drafts language plpgsql security definer set search_path = '' as $$
declare d public.mcp_sms_drafts;
begin
  select * into d from public.mcp_sms_drafts where id=p_draft and user_id=p_user;
  if not found then raise exception 'draft not found' using errcode='P0002'; end if;
  perform private.require_mcp_grant(p_user,d.grant_id,'messages:send',d.line_id);
  select * into d from public.mcp_sms_drafts where id=p_draft for update;
  if d.state='submitted' then return d; end if;
  if d.expires_at<=now() or d.state='rejected' then raise exception 'draft expired or rejected' using errcode='55000'; end if;
  update public.mcp_sms_drafts set state=case when p_approve then 'approved' else 'rejected' end,
    approved_at=case when p_approve then now() else null end where id=p_draft returning * into d;
  return d;
end;
$$;

create function public.mcp_prepare_sms(p_user uuid,p_grant uuid,p_draft uuid,p_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.mcp_sms_drafts; result jsonb; prior text := current_setting('request.jwt.claim.sub',true);
begin
  perform private.require_mcp_grant(p_user,p_grant,'messages:send');
  select * into d from public.mcp_sms_drafts where id=p_draft and grant_id=p_grant and user_id=p_user for update;
  if not found then raise exception 'draft not found' using errcode='P0002'; end if;
  perform private.require_mcp_grant(p_user,p_grant,'messages:send',d.line_id);
  -- The draft's message link is permanent, even after the API idempotency TTL.
  if d.message_id is not null then
    return jsonb_build_object('messageId',d.message_id,'conversationId',(select conversation_id from public.messages where id=d.message_id),'destination',d.destination,'fromNumber',(select phone_number from public.lines where id=d.line_id),'replayed',true);
  end if;
  if d.state<>'approved' or d.approved_at is null then raise exception 'approval required' using errcode='42501'; end if;
  if d.expires_at<=now() then raise exception 'draft expired' using errcode='55000'; end if;
  perform set_config('request.jwt.claim.sub',p_user::text,true);
  result := public.prepare_outbound_message(d.organization_id,d.line_id,d.destination,d.body,'mcp:'||d.id::text,p_hash);
  perform set_config('request.jwt.claim.sub',coalesce(prior,''),true);
  update public.mcp_sms_drafts set state='submitted',message_id=(result->>'messageId')::uuid where id=d.id;
  return result;
end;
$$;

revoke all on function public.mcp_create_grant(uuid,text,text,uuid,uuid[],text[],text),public.mcp_write_contact(uuid,uuid,uuid,jsonb),public.mcp_create_sms_draft(uuid,uuid,uuid,uuid,text,text),public.mcp_decide_sms(uuid,uuid,boolean),public.mcp_prepare_sms(uuid,uuid,uuid,text) from public,anon,authenticated,onoff_mcp;
grant execute on function public.mcp_create_grant(uuid,text,text,uuid,uuid[],text[],text),public.mcp_write_contact(uuid,uuid,uuid,jsonb),public.mcp_create_sms_draft(uuid,uuid,uuid,uuid,text,text),public.mcp_decide_sms(uuid,uuid,boolean),public.mcp_prepare_sms(uuid,uuid,uuid,text) to service_role;

-- Shared request limits across API instances.
alter table public.api_rate_limit_windows drop constraint api_rate_limit_windows_operation_check;
alter table public.api_rate_limit_windows add constraint api_rate_limit_windows_operation_check check (operation in ('voice_token','call_intent','sms_send','voice_client_diagnostic','mcp_request'));
create or replace function public.consume_api_rate_limit(p_user_id uuid,p_operation text,p_window_seconds integer,p_max_requests integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_start timestamptz; v_count integer;
begin
  if p_user_id is null or p_operation is null or p_operation not in ('voice_token','call_intent','sms_send','voice_client_diagnostic','mcp_request') or p_window_seconds not between 1 and 3600 or p_max_requests not between 1 and 1000 then raise exception 'invalid API rate limit request' using errcode='22023'; end if;
  v_start:=to_timestamp(floor(extract(epoch from now())/p_window_seconds)*p_window_seconds);
  insert into public.api_rate_limit_windows values(p_user_id,p_operation,v_start,1,v_start+make_interval(secs=>p_window_seconds*2))
    on conflict(user_id,operation,window_started_at) do update set request_count=public.api_rate_limit_windows.request_count+1 returning request_count into v_count;
  return v_count<=p_max_requests;
end;
$$;
