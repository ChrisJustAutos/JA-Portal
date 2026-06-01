-- ═══════════════════════════════════════════════════════════════════
-- 049_b2b_test_orders.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd, then kept for reference.
--
-- Lets admins place TEST orders on behalf of a distributor that fire the full
-- real pipeline. Flag-only — test orders behave exactly like real orders; the
-- flag is for identification ([TEST] badge / filtering / later report exclusion)
-- and to gate the "mark paid" shortcut to test orders only.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.b2b_orders
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
