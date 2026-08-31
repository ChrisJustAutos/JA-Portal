-- 211_b2b_cart_reminders.sql
--
-- Abandoned-cart reminders for the distributor portal. Two nudges per cart —
-- 24h and 72h after it was last touched — then silence.
--
-- These stamps are compared against the cart's LAST-TOUCHED time, which is
-- derived from b2b_cart_items (added_at/updated_at), NOT b2b_carts.updated_at:
-- the item routes bump the item rows, not the cart. Comparing the stamp to the
-- item timestamp is also what re-arms a reminder — touch the cart and the
-- stamp is older than the new activity, so the cycle legitimately starts over.

alter table public.b2b_carts
  add column if not exists reminder_24_at timestamptz,
  add column if not exists reminder_72_at timestamptz;

comment on column public.b2b_carts.reminder_24_at is
  'When the 24h abandoned-cart reminder was last sent. Re-arms when the cart is touched again (compared against the newest b2b_cart_items timestamp).';
comment on column public.b2b_carts.reminder_72_at is
  'When the 72h abandoned-cart reminder was last sent. Re-arms when the cart is touched again.';

-- The sweep filters on carts that have not been reminded yet, oldest first.
create index if not exists b2b_carts_reminder_idx
  on public.b2b_carts (reminder_24_at, reminder_72_at);
