create policy onoff_authenticated_receive_scoped_activity
on realtime.messages
for select to authenticated
using (
  extension = 'broadcast'
  and case
    when realtime.topic() ~ '^org:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:contacts$' then exists (
      select 1 from public.memberships m
      where m.organization_id = split_part(realtime.topic(), ':', 2)::uuid
        and m.user_id = (select auth.uid()) and m.status = 'active'
    )
    when realtime.topic() ~ '^line:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:voice$' then exists (
      select 1
      from public.line_assignments a
      join public.memberships m on m.organization_id = a.organization_id and m.user_id = a.user_id
      where a.line_id = split_part(realtime.topic(), ':', 2)::uuid
        and a.user_id = (select auth.uid()) and a.status = 'active' and a.can_voice
        and m.status = 'active'
    )
    when realtime.topic() ~ '^line:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:sms$' then exists (
      select 1
      from public.line_assignments a
      join public.memberships m on m.organization_id = a.organization_id and m.user_id = a.user_id
      where a.line_id = split_part(realtime.topic(), ':', 2)::uuid
        and a.user_id = (select auth.uid()) and a.status = 'active' and a.can_sms
        and m.status = 'active'
    )
    when realtime.topic() = 'user:' || (select auth.uid())::text || ':devices' then true
    else false
  end
);

create or replace function private.broadcast_activity_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_topic text;
  v_payload jsonb;
  v_org_id uuid;
  v_line_id uuid;
begin
  if tg_table_name = 'contacts' then
    v_topic := 'org:' || new.organization_id::text || ':contacts';
    v_payload := pg_catalog.jsonb_build_object(
      'kind', 'contact', 'resourceId', new.id, 'version', new.version, 'occurredAt', pg_catalog.now()
    );
  elsif tg_table_name = 'calls' then
    v_topic := 'line:' || new.line_id::text || ':voice';
    v_payload := pg_catalog.jsonb_build_object(
      'kind', 'call', 'resourceId', new.id, 'status', new.status, 'occurredAt', pg_catalog.now()
    );
  elsif tg_table_name = 'messages' then
    select c.line_id into v_line_id
      from public.conversations c
     where c.organization_id = new.organization_id and c.id = new.conversation_id;
    if v_line_id is not null then
      v_topic := 'line:' || v_line_id::text || ':sms';
      v_payload := pg_catalog.jsonb_build_object(
        'kind', 'message', 'resourceId', new.conversation_id, 'status', new.status, 'occurredAt', pg_catalog.now()
      );
    end if;
  elsif tg_table_name = 'devices' then
    v_topic := 'user:' || new.user_id::text || ':devices';
    v_payload := pg_catalog.jsonb_build_object(
      'kind', 'device', 'resourceId', new.id, 'status', new.status, 'occurredAt', pg_catalog.now()
    );
  end if;

  if v_topic is not null then
    perform realtime.send(v_payload, 'onoff.activity', v_topic, true);
  end if;
  return new;
end;
$$;

revoke all on function private.broadcast_activity_event() from public, anon, authenticated;
grant execute on function private.broadcast_activity_event() to service_role;

create trigger contacts_broadcast_activity
  after insert or update on public.contacts
  for each row execute function private.broadcast_activity_event();

create trigger calls_broadcast_activity
  after insert or update on public.calls
  for each row execute function private.broadcast_activity_event();

create trigger messages_broadcast_activity
  after insert or update on public.messages
  for each row execute function private.broadcast_activity_event();

create trigger devices_broadcast_activity
  after insert or update on public.devices
  for each row execute function private.broadcast_activity_event();
