-- 171: auto-apply the Stripe payment in MYOB (Customer Payment → Undeposited
-- Funds) once the B2B sale invoice exists. These columns make the write
-- idempotent — one payment per order, never re-posted.
alter table b2b_orders add column if not exists myob_payment_uid text;
alter table b2b_orders add column if not exists myob_payment_at timestamptz;
