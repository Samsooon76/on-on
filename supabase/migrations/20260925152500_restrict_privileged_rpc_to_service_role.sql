-- These SECURITY DEFINER operations are called by the API with its service-role
-- client. Keep them off the exposed PostgREST RPC surface for end-user tokens.
revoke all on function public.issue_call_intent(uuid, uuid, uuid, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.issue_call_intent(uuid, uuid, uuid, text, text, text, integer)
  to service_role;

revoke all on function public.prepare_outbound_message(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.prepare_outbound_message(uuid, uuid, text, text, text, text)
  to service_role;

revoke all on function public.list_pending_outbound_messages()
  from public, anon, authenticated;
grant execute on function public.list_pending_outbound_messages()
  to service_role;

revoke all on function public.set_device_voice_state(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.set_device_voice_state(uuid, boolean)
  to service_role;
