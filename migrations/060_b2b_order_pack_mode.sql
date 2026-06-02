-- ═══════════════════════════════════════════════════════════════════
-- 060_b2b_order_pack_mode.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd, then kept for reference.
--
-- Per-order cartonizer override. When set, the freight quote + booking pack the
-- order this way instead of the automatic heuristic:
--   'auto' (or null) — weight/volume heuristic (default)
--   'cartons'        — force packing into cartons
--   'pallet'         — force onto pallet(s)
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.b2b_orders
  ADD COLUMN IF NOT EXISTS freight_pack_mode TEXT;
