-- 078_order_payment_settled.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd.
--
-- Tracks when an order's payment is actually SETTLED (money confirmed), as
-- distinct from paid_at (which marks fulfilment-on-order). Card/PayTo settle at
-- checkout; BECS settles a few days later, confirmed when the MYOB invoice shows
-- the payment applied (a cron polls MYOB a few times a day).
--   payment_settled_at      — set once the payment is confirmed/applied
--   myob_payment_checked_at — bookkeeping: last time the poller looked at MYOB

alter table public.b2b_orders
  add column if not exists payment_settled_at      timestamptz,
  add column if not exists myob_payment_checked_at timestamptz;
