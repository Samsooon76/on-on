alter table public.api_rate_limit_windows
  add constraint api_rate_limit_windows_operation_check_v2
  check (operation in ('voice_token', 'call_intent', 'sms_send', 'voice_client_diagnostic'));

alter table public.api_rate_limit_windows
  validate constraint api_rate_limit_windows_operation_check_v2;

alter table public.api_rate_limit_windows
  drop constraint api_rate_limit_windows_operation_check;

alter table public.api_rate_limit_windows
  rename constraint api_rate_limit_windows_operation_check_v2 to api_rate_limit_windows_operation_check;

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
     or p_operation not in ('voice_token', 'call_intent', 'sms_send', 'voice_client_diagnostic')
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
