-- 191: drop-ship supplier-confirmation inbox watch.
--
-- Chris (2026-08-06): "Should been done automatically when that MPI
-- confirmation arrives" — the PO→Bill + invoice conversion must fire off the
-- supplier's confirmation email landing in orders@justautoswholesale.com,
-- not off a Portal button. This log makes the 15-min inbox scan idempotent:
-- one row per scanned message, claimed (inserted) BEFORE any action runs, so
-- overlapping cron invocations can never double-bill a PO. The unique index
-- is the claim.

create table if not exists b2b_dropship_confirm_log (
  id uuid primary key default gen_random_uuid(),
  mailbox text not null,
  graph_message_id text not null,
  internet_message_id text,
  subject text,
  from_email text,
  received_at timestamptz,
  order_id uuid references b2b_orders(id) on delete set null,
  -- processing → claimed; then confirmed | no_match | not_confirmation | self | error
  action text not null default 'processing',
  detail text,
  created_at timestamptz not null default now()
);

create unique index if not exists b2b_dropship_confirm_log_msg_uq
  on b2b_dropship_confirm_log (mailbox, graph_message_id);
create index if not exists b2b_dropship_confirm_log_order_idx
  on b2b_dropship_confirm_log (order_id);

alter table b2b_dropship_confirm_log enable row level security;
