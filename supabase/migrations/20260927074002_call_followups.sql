-- Follow-ups created from the dialer inherit the original call's access rules.
create table public.call_followups (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  call_id uuid not null,
  contact_id uuid,
  created_by uuid not null references auth.users(id) on delete restrict,
  kind text not null check (kind in ('ticket', 'deal')),
  title text not null check (length(trim(title)) between 1 and 160),
  description text not null default '' check (length(description) <= 5000),
  priority text not null default 'normal' check (priority in ('normal', 'high', 'urgent')),
  amount numeric(11,2) check (amount >= 0),
  status text not null default 'open',
  created_at timestamptz not null default now(),
  foreign key (organization_id, call_id) references public.calls(organization_id, id) on delete restrict,
  foreign key (organization_id, contact_id) references public.contacts(organization_id, id) on delete restrict,
  check ((kind = 'ticket' and amount is null and status in ('open', 'closed')) or
         (kind = 'deal' and status in ('open', 'won', 'lost')))
);
create index call_followups_org_created on public.call_followups(organization_id, created_at desc, id desc);
create index call_followups_call on public.call_followups(organization_id, call_id);
create index call_followups_contact on public.call_followups(organization_id, contact_id);
create index call_followups_creator on public.call_followups(created_by);
alter table public.call_followups enable row level security;
revoke all on public.call_followups from anon, authenticated;
grant select, insert on public.call_followups to authenticated;
grant update(status) on public.call_followups to authenticated;
grant all on public.call_followups to service_role;
create policy call_followups_read on public.call_followups for select to authenticated using (
  exists (select 1 from public.calls c where c.id = call_id and c.organization_id = call_followups.organization_id)
);
create policy call_followups_create on public.call_followups for insert to authenticated with check (
  created_by = (select auth.uid()) and
  exists (select 1 from public.calls c where c.id = call_id and c.organization_id = call_followups.organization_id) and
  (contact_id is null or exists (select 1 from public.contacts c where c.id = contact_id and c.organization_id = call_followups.organization_id and c.archived_at is null))
);
create policy call_followups_update on public.call_followups for update to authenticated using (
  exists (select 1 from public.calls c where c.id = call_id and c.organization_id = call_followups.organization_id)
) with check (
  exists (select 1 from public.calls c where c.id = call_id and c.organization_id = call_followups.organization_id)
);
