-- Run in your application's private database, not a public Data API schema.
create table onoff_webhook_inbox (
  event_id uuid primary key,
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index onoff_webhook_inbox_pending on onoff_webhook_inbox(received_at) where processed_at is null;
