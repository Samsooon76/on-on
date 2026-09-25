-- The API currently forwards the verified end-user JWT to these explicitly
-- membership-scoped SECURITY DEFINER routines, which depend on auth.uid().
grant execute on function public.issue_call_intent(uuid, uuid, uuid, text, text, text, integer)
  to authenticated;
grant execute on function public.prepare_outbound_message(uuid, uuid, text, text, text, text)
  to authenticated;
grant execute on function public.list_pending_outbound_messages()
  to authenticated;
grant execute on function public.set_device_voice_state(uuid, boolean)
  to authenticated;
