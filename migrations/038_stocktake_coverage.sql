-- ═══════════════════════════════════════════════════════════════════
-- 038_stocktake_coverage.sql
-- Coverage check for stocktakes: compare the counted sheet against MD's
-- full in-stock universe (the Stock Value report) so nothing in the system
-- is missed. Computed by the match worker after the SKU match pass.
--   coverage = { total, counted, uncounted_count, uncounted_value,
--                uncounted: [{stock_number,name,available,buy_price,value}],
--                source }
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.stocktake_uploads
  ADD COLUMN IF NOT EXISTS coverage_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS in_stock_total     INTEGER,
  ADD COLUMN IF NOT EXISTS in_stock_uncounted INTEGER,
  ADD COLUMN IF NOT EXISTS coverage           JSONB;
