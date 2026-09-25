create or replace function public.record_answered_call_device(
  p_account_sid text,
  p_call_sid text,
  p_voice_identity text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_call_leg_id uuid;
  v_call_id uuid;
  v_device_id uuid;
  v_user_id uuid;
  v_updated integer;
  v_released integer;
begin
  if p_account_sid is null
     or p_call_sid is null or p_call_sid !~ '^CA[0-9a-fA-F]{32}$'
     or p_voice_identity is null or length(p_voice_identity) not between 1 and 121 then
    raise exception 'invalid answered call device payload' using errcode = '22023';
  end if;

  select leg.id, leg.call_id, device.id, device.user_id
    into v_call_leg_id, v_call_id, v_device_id, v_user_id
    from public.call_legs leg
    join public.calls call_record
      on call_record.organization_id = leg.organization_id
     and call_record.id = leg.call_id
    join public.lines line
      on line.organization_id = call_record.organization_id
     and line.id = call_record.line_id
    join public.devices device
      on device.organization_id = leg.organization_id
     and device.voice_identity = p_voice_identity
   where leg.provider_call_sid = p_call_sid
     and leg.parent_call_sid is not null
     and call_record.direction = 'inbound'
     and line.twilio_account_sid = p_account_sid
     and (leg.status = 'answered' or leg.answered_at is not null)
   for update of leg, call_record;

  if not found then
    return pg_catalog.jsonb_build_object('recorded', false, 'reason', 'no_matching_answered_device');
  end if;

  if exists (
    select 1 from public.call_legs other_leg
     where other_leg.call_id = v_call_id
       and other_leg.device_id is not null
       and other_leg.id <> v_call_leg_id
  ) then
    return pg_catalog.jsonb_build_object('recorded', false, 'reason', 'call_already_has_winner');
  end if;

  update public.call_legs
     set device_id = v_device_id
   where id = v_call_leg_id
     and (device_id is null or device_id = v_device_id);
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    return pg_catalog.jsonb_build_object('recorded', false, 'reason', 'device_already_set');
  end if;

  update public.call_reservations
     set status = 'released', expires_at = now()
   where call_id = v_call_id
     and user_id <> v_user_id
     and status in ('preparing', 'active');
  get diagnostics v_released = row_count;

  return pg_catalog.jsonb_build_object('recorded', true, 'releasedReservations', v_released);
end;
$$;
