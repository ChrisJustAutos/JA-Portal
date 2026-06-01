-- ═══════════════════════════════════════════════════════════════════
-- 054_b2b_catalogue_handling_inbound.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd, then kept for reference.
--
-- Per-item freight surcharges, both CHARGED to the distributor (added on top
-- of the MachShip-quoted freight, ex GST):
--   - manual_handling_fee_ex_gst   applied PER UNIT × qty (awkward/oversize items)
--   - inbound_freight_cost_ex_gst  applied PER UNIT × qty (cost to land the stock)
-- Both fold into the freight line at quote time (lib/b2b-freight.getLiveQuote).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.b2b_catalogue
  ADD COLUMN IF NOT EXISTS manual_handling_fee_ex_gst  NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS inbound_freight_cost_ex_gst NUMERIC(10,2);
