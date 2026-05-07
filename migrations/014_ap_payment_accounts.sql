-- ═══════════════════════════════════════════════════════════════════
-- 014_ap_payment_accounts.sql
-- "Mark as paid" support for AP invoices.
--
-- ap_payment_accounts: admin-managed list of clearing/payment-from
-- accounts per MYOB company file. Examples: Capricorn liability
-- account 2-1120, direct-debit clearing 1-1100, credit-card account.
-- One row per file may be flagged as the Capricorn default — when an
-- AP invoice has via_capricorn=true the UI auto-ticks "Mark as paid"
-- and selects that row.
--
-- ap_invoices new cols: payment_account_* hold the chosen account at
-- approval time; myob_payment_* are written after the
-- Purchase/PaymentTxn call succeeds in MYOB.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ap_payment_accounts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  myob_company_file        TEXT NOT NULL CHECK (myob_company_file IN ('VPS','JAWS')),
  label                    TEXT NOT NULL,
  account_uid              UUID NOT NULL,
  account_code             TEXT NOT NULL,
  account_name             TEXT NOT NULL,
  is_default_for_capricorn BOOLEAN NOT NULL DEFAULT false,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  sort_order               INTEGER NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One Capricorn-default per company file. Partial unique index so
-- non-default rows are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS ap_payment_accounts_one_cap_default_per_file
  ON ap_payment_accounts (myob_company_file)
  WHERE is_default_for_capricorn = true;

CREATE INDEX IF NOT EXISTS ap_payment_accounts_active_idx
  ON ap_payment_accounts (myob_company_file, is_active, sort_order);

DROP TRIGGER IF EXISTS trg_ap_payment_accounts_updated ON ap_payment_accounts;
CREATE TRIGGER trg_ap_payment_accounts_updated
  BEFORE UPDATE ON ap_payment_accounts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE ap_invoices
  ADD COLUMN IF NOT EXISTS payment_account_uid     UUID,
  ADD COLUMN IF NOT EXISTS payment_account_code    TEXT,
  ADD COLUMN IF NOT EXISTS payment_account_name    TEXT,
  ADD COLUMN IF NOT EXISTS myob_payment_uid        TEXT,
  ADD COLUMN IF NOT EXISTS myob_payment_applied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS myob_payment_error      TEXT;
