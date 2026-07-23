-- 172: concurrency claim stamps for the B2B money paths. Every idempotency
-- guard used to be read-then-act, so a webhook retry racing an admin click
-- could double-post MYOB documents, double-book consignments, double-raise
-- supplier POs or double-run refunds. Claims are taken with a conditional
-- UPDATE (… where <claim> is null or <claim> < now() - interval '10 minutes')
-- so exactly one runner wins; stale claims from crashed runs self-expire.
alter table b2b_orders add column if not exists myob_writing_at timestamptz;
alter table b2b_orders add column if not exists freight_booking_at timestamptz;
alter table b2b_orders add column if not exists dropship_raising_at timestamptz;
alter table b2b_orders add column if not exists refunding_at timestamptz;
