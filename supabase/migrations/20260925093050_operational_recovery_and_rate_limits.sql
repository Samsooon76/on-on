-- Persistent, shared API throttles and recovery scheduling for open Voice legs.
-- All entry points are limited to the trusted server role.

create table public.api_rate_limit_windows (
  user_id uuid not null,
  operation text not null check (operation in ('voice_token', 'call_intent', 'sms_send')),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  expires_at timestamptz not null,
  primary key (user_id, operation, window_started_at)
);

alter table public.api_rate_limit_windows enable row level security;
create policy api_rate_limit_windows_deny_client on public.api_rate_limit_windows
  for all to anon, authenticated using (false) with check (false);
grant select, insert, update, delete on public.api_rate_limit_windows to service_role;

create or replace function public.consume_api_rate_limit(
  p_user_id uuid,
  p_operation text,
  p_window_seconds integer,
  p_max_requests integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window_started_at timestamptz;
  v_count integer;
begin
  if p_user_id is null
     or p_operation is null
     or p_operation not in ('voice_token', 'call_intent', 'sms_send')
     or p_window_seconds not between 1 and 3600
     or p_max_requests not between 1 and 1000 then
    raise exception 'invalid API rate limit request' using errcode = '22023';
  end if;

  v_window_started_at := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );
  insert into public.api_rate_limit_windows (user_id, operation, window_started_at, request_count, expires_at)
  values (p_user_id, p_operation, v_window_started_at, 1,
          v_window_started_at + pg_catalog.make_interval(secs => p_window_seconds * 2))
  on conflict (user_id, operation, window_started_at)
  do update set request_count = public.api_rate_limit_windows.request_count + 1
  returning request_count into v_count;

  return v_count <= p_max_requests;
end;
$$;

revoke all on function public.consume_api_rate_limit(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(uuid, text, integer, integer) to service_role;

alter table public.call_legs
  add column reconcile_after timestamptz not null default now() + interval '30 seconds',
  add column reconcile_attempts integer not null default 0 check (reconcile_attempts >= 0),
  add column last_reconciled_at timestamptz;

create index call_legs_due_reconciliation_idx
  on public.call_legs(reconcile_after, created_at)
  where status in ('initiated', 'ringing', 'answered');

create or replace function public.record_call_leg_reconciliation(
  p_call_leg_id uuid,
  p_next_attempt_at timestamptz,
  p_failed boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_call_leg_id is null
     or p_next_attempt_at is null
     or p_next_attempt_at <= now()
     or p_next_attempt_at > now() + interval '1 hour' then
    raise exception 'invalid call reconciliation schedule' using errcode = '22023';
  end if;

  update public.call_legs
     set reconcile_after = p_next_attempt_at,
         reconcile_attempts = case when p_failed then reconcile_attempts + 1 else 0 end,
         last_reconciled_at = now()
   where id = p_call_leg_id and status in ('initiated', 'ringing', 'answered');
end;
$$;

create or replace function public.expire_stale_call_work()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intents integer;
  v_reservations integer;
  v_rate_windows integer;
begin
  update public.call_intents
     set status = 'expired', updated_at = now()
   where status = 'issued' and expires_at <= now();
  get diagnostics v_intents = row_count;

  update public.call_reservations
     set status = 'expired', updated_at = now()
   where status = 'preparing' and expires_at <= now();
  get diagnostics v_reservations = row_count;

  delete from public.api_rate_limit_windows where expires_at <= now();
  get diagnostics v_rate_windows = row_count;

  return pg_catalog.jsonb_build_object(
    'expiredIntents', v_intents,
    'expiredReservations', v_reservations,
    'expiredRateWindows', v_rate_windows
  );
end;
$$;

revoke all on function public.record_call_leg_reconciliation(uuid, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.record_call_leg_reconciliation(uuid, timestamptz, boolean) to service_role;
revoke all on function public.expire_stale_call_work() from public, anon, authenticated;
grant execute on function public.expire_stale_call_work() to service_role;
