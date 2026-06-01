-- ═══════════════════════════════════════════════════════════════════
-- 057_b2b_manual_handling_flag.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd, then kept for reference.
--
-- Manual handling is now a TICKBOX, not a dollar figure. When ticked, the item
-- is sent to MachShip with manualHandling=true so the carrier's quote/booking
-- price adjusts accordingly. The old per-unit fee column (054) is left in place
-- but is no longer read/written.
--   (inbound_freight_cost_ex_gst stays a $/unit surcharge — unchanged.)
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.b2b_catalogue
  ADD COLUMN IF NOT EXISTS manual_handling BOOLEAN NOT NULL DEFAULT FALSE;
