-- 218 — B2B: large orders are processed by hand, not paid at checkout.
--
-- Chris, 2026-09-02: "All distributors need to be aware when placing an order
-- ie. when it gets to $30,000 inc. freight the order will have to be manually
-- processed — instead of checkout they can send the order through with no
-- payment, have freight quoted, pick slips printed etc. and then a separate
-- bank transfer is required."
--
-- THE THRESHOLD is on the FINAL total — goods + GST + freight — because that is
-- the number the distributor actually pays. Freight is not known until it is
-- selected, so the test happens at checkout, once the total is real, rather
-- than while items are being added to the cart.
--
-- ON SUBMIT, NOTHING MOVES. The order lands as `awaiting_approval` and no
-- Stripe session is created. A human approves it, and only then does the MYOB
-- sale order get written and the warehouse work begin (freight quote, pick
-- slip). Drop-ship POs still wait for the money: they commit a supplier, and an
-- unpaid $30k order is exactly where you don't want that happening
-- automatically. Marking it paid runs the normal post-payment pipeline, which
-- is idempotent on the MYOB write and raises the POs then.
--
-- WHY A NEW STATUS rather than reusing `pending_payment`: that status already
-- means "someone reached the payment screen and backed out" — the orders list
-- shows those as Awaiting payment and the reminder cron chases them (see
-- lib/b2b-reminders). A large order awaiting a bank transfer is a different
-- thing entirely and must not be chased as an abandoned cart.
--
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd via apply_migration.

-- 1. The new state.
alter table public.b2b_orders drop constraint if exists b2b_orders_status_check;
alter table public.b2b_orders add constraint b2b_orders_status_check
  check (status = any (array[
    'awaiting_approval','pending_payment','paid','picking','packed',
    'shipped','delivered','cancelled','refunded'
  ]));

alter table public.b2b_orders
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid;

comment on column public.b2b_orders.approved_at is
  'When a manually-processed (over-threshold) order was approved for the warehouse to work on. Payment is separate — see paid_at.';

-- 2. The threshold, editable in the portal rather than hard-coded.
alter table public.b2b_settings
  add column if not exists manual_approval_threshold_inc numeric(10,2) default 30000;

update public.b2b_settings
   set manual_approval_threshold_inc = coalesce(manual_approval_threshold_inc, 30000)
 where id = 'singleton';

comment on column public.b2b_settings.manual_approval_threshold_inc is
  'Order totals (inc GST and freight) at or above this cannot be paid at checkout — they submit as awaiting_approval for manual processing and a bank transfer. NULL disables the rule entirely.';
