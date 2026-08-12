-- 195: per-line refund tracking for item-selection refunds
--
-- The admin Refund modal gains an "Items" mode: pick specific order lines
-- (and quantities) to refund instead of a raw dollar amount. To stop the
-- same item being refunded twice we track how many units of each line have
-- already been refunded this way.
--
-- Amount-only (Full / Partial $) refunds do NOT touch refunded_qty — the
-- order-level refunded_total cap remains the cash guard for those.

alter table public.b2b_order_lines
  add column if not exists refunded_qty integer not null default 0;

comment on column public.b2b_order_lines.refunded_qty is
  'Units of this line already refunded via item-selection refunds. Caps further per-line refunds; amount-only refunds do not touch it.';
