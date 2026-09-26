-- Provisioning data is server-only. A quote is scoped to one organization/user.
create table public.number_provisioning_profiles (
  organization_id uuid not null references public.organizations(id) on delete restrict,
  country text not null check (country ~ '^[A-Z]{2}$'),
  end_user_type text not null check (end_user_type in ('business', 'individual')),
  bundle_sid text check (bundle_sid ~ '^BU[0-9a-fA-F]{32}$'),
  address_sid text check (address_sid ~ '^AD[0-9a-fA-F]{32}$'),
  primary key (organization_id, country)
);

create table public.number_quotes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  user_id uuid not null,
  country text not null,
  phone_number text not null check (phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  account_sid text not null check (account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  monthly_price numeric not null check (monthly_price >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  sms_enabled boolean not null,
  bundle_sid text,
  address_sid text,
  expires_at timestamptz not null default now() + interval '10 minutes',
  created_at timestamptz not null default now(),
  foreign key (organization_id, user_id) references public.memberships(organization_id, user_id) on delete restrict
);
create index number_quotes_owner_idx on public.number_quotes(organization_id, user_id, created_at);

create table public.number_orders (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null unique references public.number_quotes(id) on delete restrict,
  organization_id uuid not null,
  user_id uuid not null,
  idempotency_key uuid not null,
  phone_number text not null,
  account_sid text not null,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  line_id uuid references public.lines(id) on delete restrict,
  failure_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, user_id) references public.memberships(organization_id, user_id) on delete restrict,
  unique (organization_id, user_id, idempotency_key)
);
-- Two tabs/replicas cannot buy the same number or start a second unresolved order.
create unique index number_orders_number_idx on public.number_orders(account_sid, phone_number) where status <> 'failed';
create unique index number_orders_pending_owner_idx on public.number_orders(organization_id, user_id) where status = 'pending';
create index number_orders_line_idx on public.number_orders(line_id) where line_id is not null;

alter table public.number_provisioning_profiles enable row level security;
alter table public.number_quotes enable row level security;
alter table public.number_orders enable row level security;
revoke all on public.number_provisioning_profiles, public.number_quotes, public.number_orders from anon, authenticated;
grant select, insert, update, delete on public.number_provisioning_profiles, public.number_quotes, public.number_orders to service_role;
create policy number_profiles_server_only on public.number_provisioning_profiles for all to anon, authenticated using (false) with check (false);
create policy number_quotes_server_only on public.number_quotes for all to anon, authenticated using (false) with check (false);
create policy number_orders_server_only on public.number_orders for all to anon, authenticated using (false) with check (false);

create function public.begin_number_order(p_org_id uuid, p_user_id uuid, p_quote_id uuid, p_key uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  q public.number_quotes;
  o public.number_orders;
begin
  -- Lock the membership to serialize purchases made by this account.
  perform 1 from public.memberships m join public.organizations g on g.id = m.organization_id
    where m.organization_id = p_org_id and m.user_id = p_user_id
      and m.status = 'active' and m.role = 'admin' and g.status = 'active' for update of m;
  if not found then raise exception 'Administrator required' using errcode = '42501'; end if;
  select * into o from public.number_orders where organization_id = p_org_id and user_id = p_user_id and idempotency_key = p_key;
  if found then
    if o.quote_id <> p_quote_id then raise exception 'Idempotency conflict' using errcode = '22023'; end if;
    return jsonb_build_object('created', false, 'order', to_jsonb(o));
  end if;
  select * into o from public.number_orders where quote_id = p_quote_id and organization_id = p_org_id and user_id = p_user_id;
  if found then return jsonb_build_object('created', false, 'order', to_jsonb(o)); end if;
  select * into q from public.number_quotes where id = p_quote_id and organization_id = p_org_id and user_id = p_user_id;
  if not found or q.expires_at <= now() then raise exception 'Quote expired or unavailable' using errcode = '22023'; end if;
  insert into public.number_orders(quote_id, organization_id, user_id, idempotency_key, phone_number, account_sid)
    values (q.id, p_org_id, p_user_id, p_key, q.phone_number, q.account_sid) returning * into o;
  insert into public.audit_events(organization_id, actor_user_id, action, target_type, target_id, outcome)
    values (p_org_id, p_user_id, 'number_order.begin', 'number_order', o.id, 'allowed');
  return jsonb_build_object('created', true, 'order', to_jsonb(o));
end;
$$;

create function public.complete_number_order(p_order_id uuid, p_account_sid text, p_number_sid text, p_phone_number text, p_voice boolean, p_sms boolean)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  o public.number_orders;
  v_line_id uuid;
begin
  select * into o from public.number_orders where id = p_order_id for update;
  if not found or o.status = 'failed' or o.account_sid <> p_account_sid or o.phone_number <> p_phone_number
    or p_number_sid !~ '^PN[0-9a-fA-F]{32}$' or p_voice is distinct from true or p_sms is null then
    raise exception 'Invalid purchased number' using errcode = '22023';
  end if;
  if o.status = 'completed' then return o.line_id; end if;
  insert into public.lines(organization_id, phone_number, twilio_account_sid, twilio_phone_number_sid, voice_enabled, sms_enabled)
    values (o.organization_id, o.phone_number, o.account_sid, p_number_sid, true, p_sms) returning id into v_line_id;
  -- Preserve the purchased asset even if the buyer's access was revoked meanwhile.
  insert into public.line_assignments(organization_id, line_id, user_id, can_voice, can_sms)
    select o.organization_id, v_line_id, o.user_id, true, p_sms
    where exists (select 1 from public.memberships where organization_id = o.organization_id and user_id = o.user_id and status = 'active');
  update public.number_orders set status = 'completed', line_id = v_line_id, updated_at = now() where id = o.id;
  insert into public.audit_events(organization_id, actor_user_id, action, target_type, target_id, outcome)
    values (o.organization_id, o.user_id, 'number_order.complete', 'line', v_line_id, 'allowed');
  return v_line_id;
end;
$$;
revoke all on function public.begin_number_order(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.complete_number_order(uuid, text, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.begin_number_order(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.complete_number_order(uuid, text, text, text, boolean, boolean) to service_role;
