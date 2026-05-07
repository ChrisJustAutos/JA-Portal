-- ═══════════════════════════════════════════════════════════════════
-- 012_ap_invoice_vendor_contact.sql
-- Persist supplier contact + address fields parsed from the invoice
-- PDF so the "Create new MYOB supplier" flow can pre-fill them.
-- All nullable; existing rows simply have NULLs and the new flow falls
-- back to the empty form. New ingests fill them via lib/ap-extraction.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE ap_invoices
  ADD COLUMN IF NOT EXISTS vendor_email    TEXT,
  ADD COLUMN IF NOT EXISTS vendor_phone    TEXT,
  ADD COLUMN IF NOT EXISTS vendor_website  TEXT,
  ADD COLUMN IF NOT EXISTS vendor_street   TEXT,
  ADD COLUMN IF NOT EXISTS vendor_city     TEXT,
  ADD COLUMN IF NOT EXISTS vendor_state    TEXT,
  ADD COLUMN IF NOT EXISTS vendor_postcode TEXT,
  ADD COLUMN IF NOT EXISTS vendor_country  TEXT;
