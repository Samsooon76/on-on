-- Admin API owns settings; clients cannot enable transcription directly.
create table public.transcription_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  auto_start boolean not null default false
);
alter table public.transcription_settings enable row level security;
revoke all on public.transcription_settings from anon, authenticated;
grant all on public.transcription_settings to service_role;
