-- Shared tag catalogue. Server-only writes; reads follow membership and call RLS.
create table public.tag_settings (
 organization_id uuid primary key references public.organizations(id) on delete cascade,
 calls_enabled boolean not null default false,
 confidence_threshold double precision not null default 0.85 check (confidence_threshold between 0.5 and 0.99),
 updated_at timestamptz not null default clock_timestamp()
);
create table public.tags (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 name text not null check (length(trim(name)) between 1 and 60), color text not null default '#246653' check (color ~ '^#[0-9a-fA-F]{6}$'),
 kind text not null check (kind='call'), ai_enabled boolean not null default false,
 prompt text not null default '' check (length(prompt) <= 2000), updated_at timestamptz not null default clock_timestamp(),
 check (not ai_enabled or length(trim(prompt)) >= 10), unique(id,organization_id,kind)
);
create unique index tags_unique_name on public.tags(organization_id,kind,lower(name));
create table public.tag_subjects (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 kind text not null check (kind='call'),
 call_id uuid not null unique references public.calls(id) on delete cascade,
 status text not null default 'idle' check (status in ('idle','pending','processing','completed','skipped','error')),
 generation integer not null default 0, lease uuid, attempts integer not null default 0,
 retry_at timestamptz not null default now(), message text, updated_at timestamptz not null default clock_timestamp(),
 unique(id,organization_id,kind)
);
create index tag_subjects_org on public.tag_subjects(organization_id);
create index tag_subjects_pending on public.tag_subjects(retry_at) where status in ('pending','processing');
create table public.tag_assignments (
 subject_id uuid not null, tag_id uuid not null, organization_id uuid not null, kind text not null,
 source text not null check (source in ('manual','ai')), excluded boolean not null default false,
 confidence double precision check (confidence between 0 and 1), primary key(subject_id,tag_id),
 foreign key(subject_id,organization_id,kind) references public.tag_subjects(id,organization_id,kind) on delete cascade,
 foreign key(tag_id,organization_id,kind) references public.tags(id,organization_id,kind) on delete cascade
);
create index tag_assignments_tag on public.tag_assignments(tag_id,organization_id,kind);
create index tag_assignments_subject on public.tag_assignments(subject_id,organization_id,kind);

alter table public.tag_settings enable row level security;
alter table public.tags enable row level security;
alter table public.tag_subjects enable row level security;
alter table public.tag_assignments enable row level security;
revoke all on public.tag_settings,public.tags,public.tag_subjects,public.tag_assignments from anon,authenticated;
grant select on public.tag_settings,public.tags,public.tag_subjects,public.tag_assignments to authenticated;
grant all on public.tag_settings,public.tags,public.tag_subjects,public.tag_assignments to service_role;
create policy tag_settings_read on public.tag_settings for select to authenticated using (exists(select 1 from public.memberships m where m.organization_id=tag_settings.organization_id and m.user_id=(select auth.uid()) and m.status='active'));
create policy tags_read on public.tags for select to authenticated using (exists(select 1 from public.memberships m where m.organization_id=tags.organization_id and m.user_id=(select auth.uid()) and m.status='active'));
create policy tag_subjects_read on public.tag_subjects for select to authenticated using (
 exists(select 1 from public.calls c where c.id=call_id and c.organization_id=tag_subjects.organization_id)
);
create policy tag_assignments_read on public.tag_assignments for select to authenticated using (exists(select 1 from public.tag_subjects s where s.id=subject_id));

create function private.stamp_tag_settings() returns trigger language plpgsql set search_path='' as $$
begin new.updated_at=clock_timestamp(); return new; end $$;
create trigger tag_settings_revision before update on public.tag_settings for each row execute function private.stamp_tag_settings();

-- Lock the organisation settings for catalogue edits and result commits. A result
-- from an old prompt or from before disabling AI must never be applied.
create function private.tag_catalog_changed() returns trigger language plpgsql set search_path='' as $$
begin
 insert into public.tag_settings(organization_id) values(coalesce(new.organization_id,old.organization_id)) on conflict do nothing;
 update public.tag_settings set updated_at=clock_timestamp() where organization_id=coalesce(new.organization_id,old.organization_id);
 if tg_op='DELETE' then return old; end if;
 new.updated_at=clock_timestamp(); return new;
end $$;
create trigger tags_revision before insert or update or delete on public.tags for each row execute function private.tag_catalog_changed();

-- Durable queue: input changes invalidate in-flight leases; retries survive API restarts.
create function private.queue_tag_input() returns trigger language plpgsql security definer set search_path='' as $$
declare org uuid;
begin
 if new.status <> 'completed' then return new; end if;
 if tg_op='UPDATE' and old.status='completed' and old.snapshot=new.snapshot then return new; end if;
 select organization_id into org from public.calls where id=new.call_id;
 if not exists(select 1 from public.tag_settings where organization_id=org and calls_enabled) then return new; end if;
 insert into public.tag_subjects(organization_id,kind,call_id,status,generation) values(org,'call',new.call_id,'pending',1)
 on conflict(call_id) do update set status='pending',generation=tag_subjects.generation+1,lease=null,attempts=0,retry_at=now();
 return new;
end $$;
revoke all on function private.queue_tag_input() from public,anon,authenticated;
create trigger transcript_queue_tags after insert or update on public.call_transcriptions for each row execute function private.queue_tag_input();

create function public.claim_tag_job(p_id uuid default null) returns setof public.tag_subjects language sql set search_path='' as $$
 update public.tag_subjects set status='processing',lease=gen_random_uuid(),attempts=attempts+1,retry_at=now()+interval '60 seconds'
 where id=(select id from public.tag_subjects where (p_id is null or id=p_id) and status in ('pending','processing') and retry_at<=now() order by retry_at for update skip locked limit 1)
 returning *
$$;
create function public.finish_tag_job(p_id uuid,p_lease uuid,p_revision timestamptz,p_tag uuid,p_confidence double precision,p_status text,p_message text)
returns boolean language plpgsql set search_path='' as $$
declare s public.tag_subjects; cfg public.tag_settings;
begin
 -- Lock settings before the subject so catalogue changes invalidate old results.
 select * into cfg from public.tag_settings where organization_id=(select organization_id from public.tag_subjects where id=p_id) for update;
 select * into s from public.tag_subjects where id=p_id and lease=p_lease for update;
 if s.id is null then return false; end if;
 if p_status='completed' and (cfg.updated_at is distinct from p_revision or not coalesce(cfg.calls_enabled,false)) then
   update public.tag_subjects set status='skipped',lease=null,message='Configuration modifiée. Relancez l’analyse.' where id=p_id; return false;
 end if;
 if p_status='completed' then
   delete from public.tag_assignments where subject_id=p_id and source='ai';
   if p_tag is not null then
     insert into public.tag_assignments(subject_id,tag_id,organization_id,kind,source,confidence)
     select p_id,id,organization_id,kind,'ai',p_confidence from public.tags where id=p_tag and organization_id=s.organization_id and kind=s.kind and ai_enabled
     on conflict(subject_id,tag_id) do nothing; -- manual assignments and exclusions always win
   end if;
 end if;
 update public.tag_subjects set status=p_status,lease=null,message=p_message,updated_at=clock_timestamp(),retry_at=now()+interval '30 seconds'*power(2,least(greatest(s.attempts-1,0),3)) where id=p_id;
 return true;
end $$;
revoke all on function public.claim_tag_job(uuid),public.finish_tag_job(uuid,uuid,timestamptz,uuid,double precision,text,text) from public,anon,authenticated;
grant execute on function public.claim_tag_job(uuid),public.finish_tag_job(uuid,uuid,timestamptz,uuid,double precision,text,text) to service_role;

alter table public.api_rate_limit_windows drop constraint api_rate_limit_windows_operation_check;
alter table public.api_rate_limit_windows add constraint api_rate_limit_windows_operation_check check (operation in ('voice_token','call_intent','sms_send','voice_client_diagnostic','mcp_request','tag_classify'));
create or replace function public.consume_api_rate_limit(p_user_id uuid,p_operation text,p_window_seconds integer,p_max_requests integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_start timestamptz; v_count integer;
begin
  if p_user_id is null or p_operation is null or p_operation not in ('voice_token','call_intent','sms_send','voice_client_diagnostic','mcp_request','tag_classify') or p_window_seconds not between 1 and 3600 or p_max_requests not between 1 and 1000 then raise exception 'invalid API rate limit request' using errcode='22023'; end if;
  v_start:=to_timestamp(floor(extract(epoch from now())/p_window_seconds)*p_window_seconds);
  insert into public.api_rate_limit_windows values(p_user_id,p_operation,v_start,1,v_start+make_interval(secs=>p_window_seconds*2))
    on conflict(user_id,operation,window_started_at) do update set request_count=public.api_rate_limit_windows.request_count+1 returning request_count into v_count;
  return v_count<=p_max_requests;
end;
$$;
