-- ═══════════════════════════════════════════════════════════════════
-- 119_b2b_item_stock_thresholds.sql
-- Per-item Stock Wall colour thresholds. Each catalogue product can carry
-- its own red/amber low-stock levels; when NULL the board's shared default
-- (b2b_stock_overview_config.red_below / amber_below) applies. Stored on the
-- product so the same colours show on the admin Stock Wall and on each
-- supplier's wall.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.b2b_catalogue
  ADD COLUMN IF NOT EXISTS stock_red_below   INT,
  ADD COLUMN IF NOT EXISTS stock_amber_below INT;
