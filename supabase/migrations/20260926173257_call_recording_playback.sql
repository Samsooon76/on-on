-- Audio remains at Twilio; access is proxied by the API after the call's RLS check.
alter table public.call_transcriptions
  add column recording_sid text check (recording_sid ~ '^RE[0-9a-fA-F]{32}$'),
  add column recording_stop_requested boolean not null default false,
  add column recording_status text check (recording_status in ('starting','recording','processing','ready','unavailable','failed')),
  add column recording_duration_seconds integer check (recording_duration_seconds >= 0),
  add column recording_started_at timestamptz,
  add column recording_updated_at timestamptz,
  add column recording_error text,
  add constraint call_transcriptions_ready_recording check (recording_status <> 'ready' or recording_sid is not null);
create unique index call_transcriptions_recording_sid_unique on public.call_transcriptions(recording_sid) where recording_sid is not null;
comment on table public.call_transcriptions is 'Scribe live text and optional Twilio recording metadata. Audio media is served through the authenticated API; existing call RLS applies.';
