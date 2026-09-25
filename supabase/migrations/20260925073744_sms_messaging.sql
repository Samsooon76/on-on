create or replace function public.prepare_outbound_message(
  p_org_id uuid,
  p_line_id uuid,
  p_destination text,
  p_body text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_line public.lines%rowtype;
  v_conversation_id uuid;
  v_message_id uuid;
  v_idempotency_id uuid;
  v_existing_hash text;
  v_existing_body jsonb;
  v_existing_status text;
  v_allowed_destination boolean;
  v_daily_limit integer := 20;
  v_recent_messages integer;
begin
  if v_user_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_destination !~ '^\+[1-9][0-9]{7,14}$' or p_body is null or length(btrim(p_body)) not between 1 and 1600
     or p_idempotency_key is null or length(p_idempotency_key) not between 8 and 128
     or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid outbound message' using errcode = '22023';
  end if;

  select l.* into v_line
    from public.lines l
    join public.line_assignments a on a.organization_id = l.organization_id and a.line_id = l.id
    join public.memberships m on m.organization_id = a.organization_id and m.user_id = a.user_id
   where l.organization_id = p_org_id and l.id = p_line_id and l.status = 'active' and l.sms_enabled
     and a.user_id = v_user_id and a.status = 'active' and a.can_sms and m.status = 'active';
  if not found then raise exception 'sms permission denied' using errcode = '42501'; end if;

  if not exists (
    select 1 from public.organizations o,
      pg_catalog.jsonb_array_elements_text(coalesce(o.settings #> '{sms,allowedDestinationPrefixes}', '["+32"]'::jsonb)) prefix(value)
     where o.id = p_org_id and o.status = 'active'
       and prefix.value ~ '^\+[1-9][0-9]{0,14}$' and p_destination like prefix.value || '%'
  ) then raise exception 'destination not allowed' using errcode = '42501'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org_id::text || ':' || p_line_id::text || ':sms', 0));
  delete from public.idempotency_requests where organization_id = p_org_id and actor_user_id = v_user_id
    and operation = 'send_message' and idempotency_key = p_idempotency_key and expires_at <= now();
  insert into public.idempotency_requests (organization_id, actor_user_id, operation, idempotency_key, request_hash, expires_at)
  values (p_org_id, v_user_id, 'send_message', p_idempotency_key, p_request_hash, now() + interval '24 hours')
  on conflict (organization_id, actor_user_id, operation, idempotency_key) do nothing
  returning id into v_idempotency_id;
  if v_idempotency_id is null then
    select id, request_hash, response_body, status into v_idempotency_id, v_existing_hash, v_existing_body, v_existing_status
      from public.idempotency_requests where organization_id = p_org_id and actor_user_id = v_user_id
       and operation = 'send_message' and idempotency_key = p_idempotency_key for update;
    if v_existing_hash is distinct from p_request_hash then raise exception 'idempotency conflict' using errcode = '22023'; end if;
    if v_existing_status = 'completed' then
      return coalesce(v_existing_body, '{}'::jsonb) || pg_catalog.jsonb_build_object('replayed', true);
    end if;
    raise exception 'message request is already being processed' using errcode = '55000';
  end if;

  select case when (o.settings #>> '{sms,dailyMessageLimit}') ~ '^[0-9]{1,3}$'
                then least(100, greatest(1, (o.settings #>> '{sms,dailyMessageLimit}')::integer))
              else 20 end
    into v_daily_limit from public.organizations o where o.id = p_org_id;
  select count(*)::integer into v_recent_messages from public.messages msg
    join public.conversations c on c.organization_id = msg.organization_id and c.id = msg.conversation_id
   where msg.organization_id = p_org_id and msg.direction = 'outbound' and msg.created_at >= now() - interval '24 hours'
     and c.line_id = p_line_id;
  if v_recent_messages >= v_daily_limit then raise exception 'daily sms limit reached' using errcode = '54000'; end if;

  insert into public.conversations (organization_id, line_id, remote_number, last_message_at)
  values (p_org_id, p_line_id, p_destination, now())
  on conflict (organization_id, line_id, remote_number) do update set updated_at = now()
  returning id into v_conversation_id;
  insert into public.messages (organization_id, conversation_id, direction, body, status)
  values (p_org_id, v_conversation_id, 'outbound', btrim(p_body), 'submitting')
  returning id into v_message_id;
  update public.conversations set last_message_at = now() where id = v_conversation_id;
  update public.idempotency_requests set status = 'completed', response_status = 201,
    response_body = pg_catalog.jsonb_build_object('messageId', v_message_id, 'conversationId', v_conversation_id,
      'lineId', p_line_id, 'fromNumber', v_line.phone_number, 'destination', p_destination)
   where id = v_idempotency_id;
  return pg_catalog.jsonb_build_object('messageId', v_message_id, 'conversationId', v_conversation_id,
    'lineId', p_line_id, 'fromNumber', v_line.phone_number, 'destination', p_destination);
end;
$$;

create or replace function public.update_outbound_message_result(
  p_message_id uuid,
  p_message_sid text,
  p_status text,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message public.messages%rowtype;
  v_new_status text;
begin
  if p_message_id is null or p_status not in ('pending', 'submitting', 'unknown', 'sent', 'delivered', 'undelivered', 'failed')
     or (p_message_sid is not null and p_message_sid !~ '^SM[0-9a-fA-F]{32}$') then
    raise exception 'invalid outbound result' using errcode = '22023';
  end if;
  select * into v_message from public.messages where id = p_message_id and direction = 'outbound' for update;
  if not found then raise exception 'message not found' using errcode = 'P0002'; end if;
  v_new_status := case
    when v_message.status = 'delivered' then 'delivered'
    when v_message.status in ('failed', 'undelivered') and p_status in ('pending', 'submitting', 'unknown', 'sent') then v_message.status
    else p_status
  end;
  update public.messages set provider_message_sid = coalesce(provider_message_sid, p_message_sid),
    status = v_new_status, provider_error_code = coalesce(p_error_code, provider_error_code),
    sent_at = coalesce(sent_at, case when v_new_status in ('sent', 'delivered') then now() end),
    delivered_at = coalesce(delivered_at, case when v_new_status = 'delivered' then now() end)
   where id = p_message_id;
  return pg_catalog.jsonb_build_object('messageId', p_message_id, 'status', v_new_status);
end;
$$;

create or replace function public.apply_message_status(
  p_account_sid text,
  p_message_id uuid,
  p_message_sid text,
  p_status text,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message public.messages%rowtype;
  v_event_id uuid;
  v_new_status text;
begin
  if p_account_sid is null or p_message_id is null or p_message_sid is null or p_message_sid !~ '^SM[0-9a-fA-F]{32}$'
     or p_status not in ('accepted', 'queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed', 'read') then
    raise exception 'invalid message status' using errcode = '22023';
  end if;
  select msg.* into v_message
    from public.messages msg
    join public.conversations c on c.organization_id = msg.organization_id and c.id = msg.conversation_id
    join public.lines l on l.organization_id = c.organization_id and l.id = c.line_id
   where msg.id = p_message_id and msg.direction = 'outbound' and l.twilio_account_sid = p_account_sid
   for update of msg;
  if not found then raise exception 'message not found' using errcode = 'P0002'; end if;
  insert into public.provider_events (provider, provider_account_sid, resource_sid, event_type, dedupe_key)
  values ('twilio', p_account_sid, p_message_sid, 'message.status.' || p_status,
    'message:' || p_account_sid || ':' || p_message_sid || ':' || p_status)
  on conflict (dedupe_key) do nothing returning id into v_event_id;
  if v_event_id is null then return pg_catalog.jsonb_build_object('duplicate', true); end if;
  if v_message.provider_message_sid is not null and v_message.provider_message_sid <> p_message_sid then
    raise exception 'message sid mismatch' using errcode = '22023';
  end if;
  v_new_status := case p_status
    when 'delivered' then 'delivered'
    when 'read' then 'delivered'
    when 'undelivered' then 'undelivered'
    when 'failed' then 'failed'
    else 'sent'
  end;
  if v_message.status = 'delivered' then v_new_status := 'delivered';
  elsif v_message.status in ('failed', 'undelivered') and v_new_status = 'sent' then v_new_status := v_message.status;
  end if;
  update public.messages set provider_message_sid = coalesce(provider_message_sid, p_message_sid), status = v_new_status,
    provider_error_code = coalesce(p_error_code, provider_error_code),
    sent_at = coalesce(sent_at, case when v_new_status in ('sent', 'delivered') then now() end),
    delivered_at = coalesce(delivered_at, case when v_new_status = 'delivered' then now() end)
   where id = p_message_id;
  update public.provider_events set outcome = 'applied', applied_at = now() where id = v_event_id;
  return pg_catalog.jsonb_build_object('duplicate', false, 'messageId', p_message_id, 'status', v_new_status);
end;
$$;

create or replace function public.create_inbound_message(
  p_account_sid text,
  p_message_sid text,
  p_from text,
  p_to text,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line public.lines%rowtype;
  v_conversation_id uuid;
  v_message_id uuid;
  v_event_id uuid;
begin
  if p_account_sid is null or p_message_sid is null or p_message_sid !~ '^SM[0-9a-fA-F]{32}$'
     or p_from !~ '^\+[1-9][0-9]{7,14}$' or p_to !~ '^\+[1-9][0-9]{7,14}$'
     or p_body is null or length(p_body) not between 1 and 1600 then
    raise exception 'invalid inbound message' using errcode = '22023';
  end if;
  select * into v_line from public.lines where twilio_account_sid = p_account_sid and phone_number = p_to
    and status = 'active' and sms_enabled;
  if not found then return pg_catalog.jsonb_build_object('allowed', false); end if;
  insert into public.provider_events (provider, provider_account_sid, resource_sid, event_type, dedupe_key)
  values ('twilio', p_account_sid, p_message_sid, 'message.inbound', 'message:inbound:' || p_account_sid || ':' || p_message_sid)
  on conflict (dedupe_key) do nothing returning id into v_event_id;
  if v_event_id is null then
    select id, conversation_id into v_message_id, v_conversation_id from public.messages where provider_message_sid = p_message_sid;
    return pg_catalog.jsonb_build_object('allowed', true, 'duplicate', true, 'messageId', v_message_id, 'conversationId', v_conversation_id);
  end if;
  insert into public.conversations (organization_id, line_id, remote_number, last_message_at)
  values (v_line.organization_id, v_line.id, p_from, now())
  on conflict (organization_id, line_id, remote_number) do update set last_message_at = now()
  returning id into v_conversation_id;
  insert into public.messages (organization_id, conversation_id, direction, body, status, provider_message_sid, sent_at)
  values (v_line.organization_id, v_conversation_id, 'inbound', p_body, 'received', p_message_sid, now())
  returning id into v_message_id;
  update public.provider_events set outcome = 'applied', applied_at = now() where id = v_event_id;
  return pg_catalog.jsonb_build_object('allowed', true, 'duplicate', false, 'messageId', v_message_id, 'conversationId', v_conversation_id);
end;
$$;

revoke all on function public.prepare_outbound_message(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.prepare_outbound_message(uuid, uuid, text, text, text, text) to authenticated;
revoke all on function public.update_outbound_message_result(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.update_outbound_message_result(uuid, text, text, text) to service_role;
revoke all on function public.apply_message_status(text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.apply_message_status(text, uuid, text, text, text) to service_role;
revoke all on function public.create_inbound_message(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_inbound_message(text, text, text, text, text) to service_role;
