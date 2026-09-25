-- Explicitly document that these internal ledgers are server-only.
create policy call_intents_deny_client on public.call_intents
  for all to anon, authenticated using (false) with check (false);
create policy call_legs_deny_client on public.call_legs
  for all to anon, authenticated using (false) with check (false);
create policy call_reservations_deny_client on public.call_reservations
  for all to anon, authenticated using (false) with check (false);
create policy idempotency_requests_deny_client on public.idempotency_requests
  for all to anon, authenticated using (false) with check (false);
create policy provider_events_deny_client on public.provider_events
  for all to anon, authenticated using (false) with check (false);

-- The composite foreign key is sufficient and avoids a redundant unindexed FK.
alter table public.call_reservations drop constraint if exists call_reservations_call_id_fkey;

create index audit_events_org_actor_idx on public.audit_events(organization_id, actor_user_id);
create index call_intents_org_device_user_idx on public.call_intents(organization_id, device_id, user_id);
create index call_intents_org_line_idx on public.call_intents(organization_id, line_id);
create index call_legs_org_call_created_idx on public.call_legs(organization_id, call_id, created_at);
create index call_legs_org_device_idx on public.call_legs(organization_id, device_id);
create index call_reservations_org_call_idx on public.call_reservations(organization_id, call_id) where call_id is not null;
create index call_reservations_org_user_idx on public.call_reservations(organization_id, user_id);
create index calls_org_line_idx on public.calls(organization_id, line_id);
create index conversation_reads_org_conversation_idx on public.conversation_reads(organization_id, conversation_id);
create index conversation_reads_org_conversation_message_idx on public.conversation_reads(organization_id, conversation_id, last_read_message_id);
create index conversation_reads_org_user_idx on public.conversation_reads(organization_id, user_id);
create index devices_org_user_idx on public.devices(organization_id, user_id);
create index line_assignments_org_user_idx on public.line_assignments(organization_id, user_id);
