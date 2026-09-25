-- The Supabase project grants Data API table privileges by default. Keep
-- rate-limit state strictly server-only even when RLS is bypassed by future
-- policy changes.
revoke all on table public.api_rate_limit_windows from public, anon, authenticated;
grant select, insert, update, delete on table public.api_rate_limit_windows to service_role;
