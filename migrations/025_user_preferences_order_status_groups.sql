-- ═══════════════════════════════════════════════════════════════════
-- 025_user_preferences_order_status_groups.sql
-- Per-user combined status buckets on the B2B orders page.
--
-- A list of { id, name, statuses[] } where statuses are order status
-- values (pending_payment, paid, picking, packed, shipped, delivered,
-- cancelled, refunded). Lets staff merge several statuses into one
-- filter tile (e.g. "Fulfilment" = picking+packed+shipped+delivered).
-- Empty = each status is its own tile.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS order_status_groups JSONB NOT NULL DEFAULT '[]'::jsonb;
