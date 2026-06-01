-- ═══════════════════════════════════════════════════════════════════
-- 055_b2b_invoice_on_ship.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd, then kept for reference.
--
-- Invoice-on-shipment lifecycle:
--   * On payment the distributor now gets the ORDER confirmation only.
--   * When Just Autos books freight, the MYOB Sale.Order is converted to a
--     Sale.Invoice, and the distributor is emailed the tax invoice + PDF +
--     consignment + tracking.
--
-- New columns track the converted MYOB invoice and guard the one-time
-- invoice/shipped email so re-bookings don't re-send.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.b2b_orders
  ADD COLUMN IF NOT EXISTS myob_sale_invoice_uid       TEXT,
  ADD COLUMN IF NOT EXISTS myob_sale_invoice_number    TEXT,
  ADD COLUMN IF NOT EXISTS myob_sale_invoice_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS distributor_invoice_sent_at TIMESTAMPTZ;
