create or replace function public.set_line_assignment(
  p_org_id uuid,
  p_line_id uuid,
  p_user_id uuid,
  p_actor_id uuid,
  p_can_voice boolean,
  p_can_sms boolean,
  p_revoke boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_assignment_id uuid;
  v_line_status text;
  v_voice_enabled boolean;
  v_sms_enabled boolean;
  v_action text;
begin
  if p_can_voice is null or p_can_sms is null or p_revoke is null then
    raise exception 'Line assignment flags are required' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.memberships m
    where m.organization_id = p_org_id
      and m.user_id = p_actor_id
      and m.status = 'active'
      and m.role = 'admin'
  ) then
    raise exception 'Active organization administrator required' using errcode = '42501';
  end if;

  select l.status, l.voice_enabled, l.sms_enabled
    into v_line_status, v_voice_enabled, v_sms_enabled
  from public.lines l
  where l.organization_id = p_org_id
    and l.id = p_line_id;
  if not found then
    raise exception 'Line does not belong to the organization' using errcode = '22023';
  end if;

  if p_revoke then
    update public.line_assignments a
    set status = 'revoked', can_voice = false, can_sms = false, updated_at = clock_timestamp()
    where a.organization_id = p_org_id
      and a.line_id = p_line_id
      and a.user_id = p_user_id
      and a.status = 'active'
    returning a.id into v_assignment_id;
    if v_assignment_id is null then
      return null;
    end if;
    v_action := 'line_assignment.revoke';
  else
    if not (p_can_voice or p_can_sms) then
      raise exception 'An assignment must allow voice or SMS' using errcode = '22023';
    end if;
    if v_line_status <> 'active'
      or (p_can_voice and not v_voice_enabled)
      or (p_can_sms and not v_sms_enabled) then
      raise exception 'Requested line capability is unavailable' using errcode = '22023';
    end if;
    if not exists (
      select 1
      from public.memberships m
      where m.organization_id = p_org_id
        and m.user_id = p_user_id
        and m.status = 'active'
    ) then
      raise exception 'Active target membership required' using errcode = '23503';
    end if;

    insert into public.line_assignments (
      organization_id, line_id, user_id, can_voice, can_sms, status
    ) values (
      p_org_id, p_line_id, p_user_id, p_can_voice, p_can_sms, 'active'
    )
    on conflict (organization_id, line_id, user_id) do update
      set can_voice = excluded.can_voice,
          can_sms = excluded.can_sms,
          status = 'active',
          updated_at = clock_timestamp()
    returning id into v_assignment_id;
    v_action := 'line_assignment.upsert';
  end if;

  insert into public.audit_events (
    organization_id, actor_user_id, action, target_type, target_id, outcome
  ) values (
    p_org_id, p_actor_id, v_action, 'line_assignment', v_assignment_id, 'allowed'
  );
  return v_assignment_id;
end;
$function$;

revoke all on function public.set_line_assignment(uuid, uuid, uuid, uuid, boolean, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.set_line_assignment(uuid, uuid, uuid, uuid, boolean, boolean, boolean)
  to service_role;
