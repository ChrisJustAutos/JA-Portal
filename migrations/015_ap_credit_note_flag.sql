-- ═══════════════════════════════════════════════════════════════════
-- 015_ap_credit_note_flag.sql
-- Flag for credit notes / supplier credits / adjustment notes so the
-- portal blocks them from being posted as regular bills (which would
-- book the credit as a payable instead of a credit). Detection is via
-- lib/ap-extraction (prompt update); manual flip is also supported via
-- the standard PATCH /api/ap/[id] endpoint.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE ap_invoices
  ADD COLUMN IF NOT EXISTS is_credit_note BOOLEAN NOT NULL DEFAULT false;
