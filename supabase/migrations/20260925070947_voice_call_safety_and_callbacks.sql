-- The first remote rollout added the lookup index. The following migration
-- includes it defensively and contains the complete callable function set.
create index if not exists call_intents_reservation_id_idx on public.call_intents(reservation_id);
