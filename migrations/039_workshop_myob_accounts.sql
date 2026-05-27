-- ═══════════════════════════════════════════════════════════════════
-- 039_workshop_myob_accounts.sql
-- Full MYOB (VPS) account map for the workshop, mirroring MechanicDesk's
-- AccountRight integration. Existing myob_sales_account_uid/name stays as the
-- DEFAULT/labour sale account; this adds the rest.
--   • part / discount / refund sale accounts
--   • Performance-style tracking category
--   • payment_accounts: per-tender deposit account + MYOB PaymentMethod
--       { cash, eftpos, card, bank_transfer, direct_debit, direct_deposit,
--         paypal, other } each = { uid, name, method }
--   • myob_posting_enabled: master gate — nothing posts to MYOB until an admin
--     turns this on (so the portal doesn't double-post while MD is still live).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.workshop_settings
  ADD COLUMN IF NOT EXISTS part_sale_account_uid    TEXT,
  ADD COLUMN IF NOT EXISTS part_sale_account_name   TEXT,
  ADD COLUMN IF NOT EXISTS discount_account_uid     TEXT,
  ADD COLUMN IF NOT EXISTS discount_account_name    TEXT,
  ADD COLUMN IF NOT EXISTS refund_account_uid       TEXT,
  ADD COLUMN IF NOT EXISTS refund_account_name      TEXT,
  ADD COLUMN IF NOT EXISTS tracking_category_uid    TEXT,
  ADD COLUMN IF NOT EXISTS tracking_category_name   TEXT,
  ADD COLUMN IF NOT EXISTS payment_accounts         JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS myob_posting_enabled     BOOLEAN NOT NULL DEFAULT false;
