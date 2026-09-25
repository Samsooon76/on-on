-- App data is available through PostgREST only with an authenticated user JWT.
-- Provider credentials and webhook-only state stay server-side.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.prevent_organization_change()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'organization_id is immutable';
  end if;
  return new;
end;
$$;

create or replace function private.protect_device_identity()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.user_id is distinct from old.user_id
     or new.voice_identity is distinct from old.voice_identity then
    raise exception 'device ownership and voice identity are immutable';
  end if;
  return new;
end;
$$;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  settings jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.memberships (
  organization_id uuid not null references public.organizations(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'member')),
  status text not null default 'active' check (status in ('active', 'suspended', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table public.lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  phone_number text not null unique check (phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  twilio_account_sid text,
  twilio_phone_number_sid text,
  voice_enabled boolean not null default false,
  sms_enabled boolean not null default false,
  status text not null default 'active' check (status in ('active', 'suspended', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (twilio_account_sid, twilio_phone_number_sid)
);

create table public.line_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  line_id uuid not null,
  user_id uuid not null,
  can_voice boolean not null default false,
  can_sms boolean not null default false,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, line_id) references public.lines(organization_id, id) on delete restrict,
  foreign key (organization_id, user_id) references public.memberships(organization_id, user_id) on delete restrict,
  unique (organization_id, line_id, user_id),
  unique (organization_id, id)
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  user_id uuid not null,
  platform text not null check (platform in ('web', 'ios', 'android', 'windows', 'macos')),
  label text not null check (length(btrim(label)) between 1 and 80),
  voice_identity text not null unique,
  status text not null default 'active' check (status in ('active', 'revoked')),
  last_active_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, user_id) references public.memberships(organization_id, user_id) on delete restrict,
  unique (organization_id, id),
  unique (organization_id, id, user_id)
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  email text,
  version integer not null default 1 check (version > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table public.contact_phones (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  contact_id uuid not null,
  phone_number text not null check (phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  label text not null default 'Mobile' check (length(btrim(label)) between 1 and 40),
  created_at timestamptz not null default now(),
  foreign key (organization_id, contact_id) references public.contacts(organization_id, id) on delete cascade,
  unique (organization_id, contact_id, phone_number),
  unique (organization_id, id)
);

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  line_id uuid not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  remote_number text not null,
  status text not null default 'initiated' check (status in ('initiated', 'ringing', 'answered', 'completed', 'missed', 'failed', 'canceled')),
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  result_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, line_id) references public.lines(organization_id, id) on delete restrict,
  unique (organization_id, id)
);

create table public.call_intents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  user_id uuid not null,
  device_id uuid not null,
  line_id uuid not null,
  destination text not null check (destination ~ '^\+[1-9][0-9]{7,14}$'),
  status text not null default 'issued' check (status in ('issued', 'consumed', 'expired', 'canceled', 'failed')),
  expires_at timestamptz not null,
  consumed_call_sid text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, device_id, user_id) references public.devices(organization_id, id, user_id) on delete restrict,
  foreign key (organization_id, line_id) references public.lines(organization_id, id) on delete restrict,
  unique (organization_id, id)
);

create table public.call_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  user_id uuid not null,
  call_id uuid references public.calls(id) on delete restrict,
  status text not null default 'preparing' check (status in ('preparing', 'active', 'released', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, user_id) references public.memberships(organization_id, user_id) on delete restrict,
  foreign key (organization_id, call_id) references public.calls(organization_id, id) on delete restrict
);
create unique index call_reservations_one_active_per_user
  on public.call_reservations(user_id) where status in ('preparing', 'active');

create table public.call_legs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  call_id uuid not null,
  device_id uuid,
  provider_call_sid text not null unique,
  parent_call_sid text,
  status text not null default 'initiated' check (status in ('initiated', 'ringing', 'answered', 'completed', 'failed', 'canceled')),
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, call_id) references public.calls(organization_id, id) on delete restrict,
  foreign key (organization_id, device_id) references public.devices(organization_id, id) on delete restrict,
  unique (organization_id, id)
);

create table public.provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('twilio')),
  provider_account_sid text not null,
  resource_sid text,
  event_type text not null,
  dedupe_key text not null unique,
  received_at timestamptz not null default now(),
  applied_at timestamptz,
  outcome text check (outcome is null or outcome in ('applied', 'duplicate', 'ignored', 'failed'))
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  line_id uuid not null,
  remote_number text not null check (remote_number ~ '^\+[1-9][0-9]{7,14}$'),
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, line_id) references public.lines(organization_id, id) on delete restrict,
  unique (organization_id, line_id, remote_number),
  unique (organization_id, id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  body text not null check (length(body) between 1 and 1600),
  status text not null default 'pending' check (status in ('pending', 'submitting', 'unknown', 'sent', 'delivered', 'undelivered', 'failed', 'received')),
  provider_message_sid text unique,
  provider_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  foreign key (organization_id, conversation_id) references public.conversations(organization_id, id) on delete restrict,
  unique (organization_id, id),
  unique (organization_id, conversation_id, id)
);

create table public.conversation_reads (
  organization_id uuid not null,
  conversation_id uuid not null,
  user_id uuid not null,
  last_read_message_id uuid,
  updated_at timestamptz not null default now(),
  primary key (conversation_id, user_id),
  foreign key (organization_id, conversation_id) references public.conversations(organization_id, id) on delete cascade,
  foreign key (organization_id, user_id) references public.memberships(organization_id, user_id) on delete cascade,
  foreign key (organization_id, conversation_id, last_read_message_id)
    references public.messages(organization_id, conversation_id, id) on delete set null (last_read_message_id)
);

create table public.idempotency_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  actor_user_id uuid not null,
  operation text not null,
  idempotency_key text not null,
  request_hash text not null,
  response_status integer,
  response_body jsonb,
  status text not null default 'started' check (status in ('started', 'completed', 'failed', 'unknown')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, actor_user_id) references public.memberships(organization_id, user_id) on delete cascade,
  unique (organization_id, actor_user_id, operation, idempotency_key)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  actor_user_id uuid,
  action text not null,
  target_type text not null,
  target_id uuid,
  outcome text not null check (outcome in ('allowed', 'denied', 'failed')),
  created_at timestamptz not null default now(),
  foreign key (organization_id, actor_user_id)
    references public.memberships(organization_id, user_id) on delete set null (actor_user_id)
);

create index memberships_user_status_idx on public.memberships(user_id, status, organization_id);
create index lines_org_status_idx on public.lines(organization_id, status);
create index line_assignments_user_status_idx on public.line_assignments(user_id, status, organization_id, line_id);
create index devices_user_status_idx on public.devices(user_id, status, organization_id);
create index contacts_org_created_idx on public.contacts(organization_id, created_at desc, id desc) where archived_at is null;
create index contacts_org_name_idx on public.contacts(organization_id, lower(display_name)) where archived_at is null;
create index contact_phones_org_number_idx on public.contact_phones(organization_id, phone_number);
create index calls_line_created_idx on public.calls(line_id, created_at desc, id desc);
create index call_intents_expiration_idx on public.call_intents(status, expires_at);
create index call_legs_call_idx on public.call_legs(call_id, created_at);
create index provider_events_resource_idx on public.provider_events(provider_account_sid, resource_sid, received_at);
create index conversations_line_activity_idx on public.conversations(line_id, last_message_at desc, id desc);
create index messages_conversation_created_idx on public.messages(conversation_id, created_at, id);
create index conversation_reads_user_idx on public.conversation_reads(user_id, organization_id);
create index idempotency_expiration_idx on public.idempotency_requests(expires_at);
create index audit_events_org_created_idx on public.audit_events(organization_id, created_at desc);

create trigger organizations_set_updated_at before update on public.organizations for each row execute function private.set_updated_at();
create trigger memberships_set_updated_at before update on public.memberships for each row execute function private.set_updated_at();
create trigger lines_set_updated_at before update on public.lines for each row execute function private.set_updated_at();
create trigger line_assignments_set_updated_at before update on public.line_assignments for each row execute function private.set_updated_at();
create trigger devices_set_updated_at before update on public.devices for each row execute function private.set_updated_at();
create trigger devices_immutable_org before update on public.devices for each row execute function private.prevent_organization_change();
create trigger devices_protect_identity before update on public.devices for each row execute function private.protect_device_identity();
create trigger contacts_set_updated_at before update on public.contacts for each row execute function private.set_updated_at();
create trigger contacts_immutable_org before update on public.contacts for each row execute function private.prevent_organization_change();
create trigger calls_set_updated_at before update on public.calls for each row execute function private.set_updated_at();
create trigger call_intents_set_updated_at before update on public.call_intents for each row execute function private.set_updated_at();
create trigger call_reservations_set_updated_at before update on public.call_reservations for each row execute function private.set_updated_at();
create trigger call_legs_set_updated_at before update on public.call_legs for each row execute function private.set_updated_at();
create trigger conversations_set_updated_at before update on public.conversations for each row execute function private.set_updated_at();
create trigger messages_set_updated_at before update on public.messages for each row execute function private.set_updated_at();

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.lines enable row level security;
alter table public.line_assignments enable row level security;
alter table public.devices enable row level security;
alter table public.contacts enable row level security;
alter table public.contact_phones enable row level security;
alter table public.calls enable row level security;
alter table public.call_intents enable row level security;
alter table public.call_reservations enable row level security;
alter table public.call_legs enable row level security;
alter table public.provider_events enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.conversation_reads enable row level security;
alter table public.idempotency_requests enable row level security;
alter table public.audit_events enable row level security;

create policy memberships_read_self on public.memberships
  for select to authenticated
  using (user_id = (select auth.uid()) and status = 'active');

create policy organizations_read_member on public.organizations
  for select to authenticated
  using (exists (
    select 1 from public.memberships m
    where m.organization_id = organizations.id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  ));

create policy lines_read_assigned on public.lines
  for select to authenticated
  using (exists (
    select 1 from public.line_assignments a
    where a.organization_id = lines.organization_id
      and a.line_id = lines.id
      and a.user_id = (select auth.uid())
      and a.status = 'active'
      and (a.can_voice or a.can_sms)
  ));

create policy assignments_read_self on public.line_assignments
  for select to authenticated
  using (user_id = (select auth.uid()) and status = 'active' and exists (
    select 1 from public.memberships m
    where m.organization_id = line_assignments.organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  ));

create policy devices_read_self on public.devices
  for select to authenticated
  using (user_id = (select auth.uid()) and exists (
    select 1 from public.memberships m
    where m.organization_id = devices.organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  ));
create policy devices_insert_self on public.devices
  for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'active' and exists (
    select 1 from public.memberships m
    where m.organization_id = devices.organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  ));
create policy devices_update_self on public.devices
  for update to authenticated
  using (user_id = (select auth.uid()) and status = 'active')
  with check (user_id = (select auth.uid()) and status = 'revoked' and exists (
    select 1 from public.memberships m
    where m.organization_id = devices.organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  ));

create policy contacts_read_member on public.contacts
  for select to authenticated
  using (exists (
    select 1 from public.memberships m
    where m.organization_id = contacts.organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  ));
create policy contacts_insert_member on public.contacts
  for insert to authenticated
  with check (exists (
    select 1 from public.memberships m
    where m.organization_id = contacts.organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  ));
create policy contacts_update_member on public.contacts
  for update to authenticated
  using (exists (
    select 1 from public.memberships m
    where m.organization_id = contacts.organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  ))
  with check (exists (
    select 1 from public.memberships m
    where m.organization_id = contacts.organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  ));

create policy contact_phones_read_member on public.contact_phones
  for select to authenticated
  using (exists (
    select 1 from public.memberships m
    where m.organization_id = contact_phones.organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  ));
create policy contact_phones_insert_member on public.contact_phones
  for insert to authenticated
  with check (exists (
    select 1 from public.memberships m
    where m.organization_id = contact_phones.organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  ));
create policy contact_phones_update_member on public.contact_phones
  for update to authenticated
  using (exists (
    select 1 from public.memberships m
    where m.organization_id = contact_phones.organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  ))
  with check (exists (
    select 1 from public.memberships m
    where m.organization_id = contact_phones.organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  ));
create policy contact_phones_delete_member on public.contact_phones
  for delete to authenticated
  using (exists (
    select 1 from public.memberships m
    where m.organization_id = contact_phones.organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  ));

create policy calls_read_voice_assignment on public.calls
  for select to authenticated
  using (exists (
    select 1 from public.line_assignments a
    where a.organization_id = calls.organization_id
      and a.line_id = calls.line_id
      and a.user_id = (select auth.uid())
      and a.status = 'active'
      and a.can_voice
      and exists (
        select 1 from public.memberships m
        where m.organization_id = a.organization_id
          and m.user_id = a.user_id
          and m.status = 'active'
      )
  ));

create policy conversations_read_sms_assignment on public.conversations
  for select to authenticated
  using (exists (
    select 1 from public.line_assignments a
    where a.organization_id = conversations.organization_id
      and a.line_id = conversations.line_id
      and a.user_id = (select auth.uid())
      and a.status = 'active'
      and a.can_sms
      and exists (
        select 1 from public.memberships m
        where m.organization_id = a.organization_id
          and m.user_id = a.user_id
          and m.status = 'active'
      )
  ));

create policy messages_read_sms_assignment on public.messages
  for select to authenticated
  using (exists (
    select 1
    from public.conversations c
    join public.line_assignments a
      on a.organization_id = c.organization_id and a.line_id = c.line_id
    where c.organization_id = messages.organization_id
      and c.id = messages.conversation_id
      and a.user_id = (select auth.uid())
      and a.status = 'active'
      and a.can_sms
      and exists (
        select 1 from public.memberships m
        where m.organization_id = a.organization_id
          and m.user_id = a.user_id
          and m.status = 'active'
      )
  ));

create policy conversation_reads_self on public.conversation_reads
  for select to authenticated
  using (user_id = (select auth.uid()) and exists (
    select 1 from public.conversations c
    join public.line_assignments a
      on a.organization_id = c.organization_id and a.line_id = c.line_id
    where c.organization_id = conversation_reads.organization_id
      and c.id = conversation_reads.conversation_id
      and a.user_id = (select auth.uid())
      and a.status = 'active'
      and a.can_sms
      and exists (
        select 1 from public.memberships m
        where m.organization_id = a.organization_id
          and m.user_id = a.user_id
          and m.status = 'active'
      )
  ));
create policy conversation_reads_insert_self on public.conversation_reads
  for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.conversations c
    join public.line_assignments a
      on a.organization_id = c.organization_id and a.line_id = c.line_id
    where c.organization_id = conversation_reads.organization_id
      and c.id = conversation_reads.conversation_id
      and a.user_id = (select auth.uid())
      and a.status = 'active'
      and a.can_sms
      and exists (
        select 1 from public.memberships m
        where m.organization_id = a.organization_id
          and m.user_id = a.user_id
          and m.status = 'active'
      )
  ));
create policy conversation_reads_update_self on public.conversation_reads
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.conversations c
    join public.line_assignments a
      on a.organization_id = c.organization_id and a.line_id = c.line_id
    where c.organization_id = conversation_reads.organization_id
      and c.id = conversation_reads.conversation_id
      and a.user_id = (select auth.uid())
      and a.status = 'active'
      and a.can_sms
      and exists (
        select 1 from public.memberships m
        where m.organization_id = a.organization_id
          and m.user_id = a.user_id
          and m.status = 'active'
      )
  ));

create policy audit_events_read_admin on public.audit_events
  for select to authenticated
  using (exists (
    select 1 from public.memberships m
    where m.organization_id = audit_events.organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and m.role = 'admin'
  ));

create or replace function public.create_contact_with_phones(
  p_org_id uuid,
  p_display_name text,
  p_email text,
  p_phones jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_contact_id uuid;
begin
  insert into public.contacts (organization_id, display_name, email)
  values (p_org_id, btrim(p_display_name), p_email)
  returning id into v_contact_id;

  insert into public.contact_phones (organization_id, contact_id, phone_number, label)
  select p_org_id, v_contact_id, phone.phone_number, coalesce(nullif(btrim(phone.label), ''), 'Mobile')
  from pg_catalog.jsonb_to_recordset(coalesce(p_phones, '[]'::jsonb)) as phone(phone_number text, label text);

  return v_contact_id;
end;
$$;

create or replace function public.update_contact_with_phones(
  p_contact_id uuid,
  p_org_id uuid,
  p_display_name text,
  p_email text,
  p_expected_version integer,
  p_phones jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_contact_id uuid;
begin
  update public.contacts
     set display_name = btrim(p_display_name), email = p_email, version = version + 1
   where id = p_contact_id
     and organization_id = p_org_id
     and version = p_expected_version
     and archived_at is null
  returning id into v_contact_id;

  if v_contact_id is null then
    return null;
  end if;

  delete from public.contact_phones
   where organization_id = p_org_id and contact_id = v_contact_id;

  insert into public.contact_phones (organization_id, contact_id, phone_number, label)
  select p_org_id, v_contact_id, phone.phone_number, coalesce(nullif(btrim(phone.label), ''), 'Mobile')
  from pg_catalog.jsonb_to_recordset(coalesce(p_phones, '[]'::jsonb)) as phone(phone_number text, label text);

  return v_contact_id;
end;
$$;

revoke all on function public.create_contact_with_phones(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.update_contact_with_phones(uuid, uuid, text, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.create_contact_with_phones(uuid, text, text, jsonb) to authenticated;
grant execute on function public.update_contact_with_phones(uuid, uuid, text, text, integer, jsonb) to authenticated;
grant usage on schema private to service_role;
grant execute on function private.set_updated_at() to service_role;
grant execute on function private.prevent_organization_change() to service_role;
grant execute on function private.protect_device_identity() to service_role;

revoke all on public.organizations, public.memberships, public.lines, public.line_assignments,
  public.devices, public.contacts, public.contact_phones, public.calls, public.call_intents,
  public.call_reservations, public.call_legs, public.provider_events, public.conversations,
  public.messages, public.conversation_reads, public.idempotency_requests, public.audit_events
from anon, authenticated;

grant select on public.organizations, public.memberships, public.lines, public.line_assignments,
  public.devices, public.contacts, public.contact_phones, public.calls, public.conversations,
  public.messages, public.conversation_reads, public.audit_events to authenticated;
grant insert, update on public.devices, public.contacts, public.contact_phones, public.conversation_reads to authenticated;
grant delete on public.contact_phones to authenticated;

grant all on public.organizations, public.memberships, public.lines, public.line_assignments,
  public.devices, public.contacts, public.contact_phones, public.calls, public.call_intents,
  public.call_reservations, public.call_legs, public.provider_events, public.conversations,
  public.messages, public.conversation_reads, public.idempotency_requests, public.audit_events
to service_role;
