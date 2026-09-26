-- One explicitly started transcription per call. Only the API writes it.
create table public.call_transcriptions (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null unique references public.calls(id) on delete cascade,
  provider_call_sid text not null check (provider_call_sid ~ '^CA[0-9a-fA-F]{32}$'),
  stream_sid text,
  stream_connected boolean not null default false,
  status text not null default 'starting' check (status in ('starting','live','stopping','completed','error')),
  started_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  snapshot jsonb not null default '{"segments":[],"partials":{"local":null,"remote":null}}'::jsonb,
  error text,
  check (jsonb_typeof(snapshot->'segments') = 'array'),
  check (jsonb_typeof(snapshot->'partials') = 'object')
);
alter table public.call_transcriptions enable row level security;
revoke all on public.call_transcriptions from anon, authenticated;
grant select on public.call_transcriptions to authenticated;
grant all on public.call_transcriptions to service_role;
-- Reuse the call's RLS: active membership AND voice assignment on that line.
create policy call_transcriptions_read on public.call_transcriptions for select to authenticated
  using (exists (select 1 from public.calls c where c.id = call_id));
comment on table public.call_transcriptions is 'Scribe v2 Realtime text only; no audio is stored. Partial text is replaced, committed segments are retained.';
