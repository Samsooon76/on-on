create or replace function public.cancel_call_intent(
  p_intent_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.call_intents%rowtype;
begin
  if p_intent_id is null or p_user_id is null then
    raise exception 'invalid call intent cancellation payload' using errcode = '22023';
  end if;

  select * into v_intent
    from public.call_intents
   where id = p_intent_id and user_id = p_user_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object('canceled', false, 'status', 'not_found');
  end if;

  if v_intent.status = 'canceled' then
    return pg_catalog.jsonb_build_object('canceled', true, 'status', 'canceled');
  end if;
  if v_intent.status <> 'issued' then
    return pg_catalog.jsonb_build_object('canceled', false, 'status', v_intent.status);
  end if;

  if v_intent.expires_at <= now() then
    update public.call_intents set status = 'expired'
     where id = v_intent.id and status = 'issued';
    update public.call_reservations set status = 'expired', expires_at = now()
     where id = v_intent.reservation_id and status = 'preparing' and call_id is null;
    return pg_catalog.jsonb_build_object('canceled', false, 'status', 'expired');
  end if;

  update public.call_intents set status = 'canceled'
   where id = v_intent.id and status = 'issued';
  update public.call_reservations set status = 'released', expires_at = now()
   where id = v_intent.reservation_id and status = 'preparing' and call_id is null;
  return pg_catalog.jsonb_build_object('canceled', true, 'status', 'canceled');
end;
$$;

revoke all on function public.cancel_call_intent(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cancel_call_intent(uuid, uuid) to service_role;
