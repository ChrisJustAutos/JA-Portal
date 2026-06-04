-- 077_order_payment_method.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd.
--
-- Records which Stripe payment method a B2B order used at checkout so we can
-- show it, skip the card surcharge for bank methods, and reconcile BECS (which
-- settles a few days after the order is placed/fulfilled).
--   'card'  — instant card (carries the card surcharge)
--   'becs'  — BECS Direct Debit (settles in 2–4 business days)
--   'payto' — PayTo (near-instant bank payment)

alter table public.b2b_orders
  add column if not exists payment_method text not null default 'card';
