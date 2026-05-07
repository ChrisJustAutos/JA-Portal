-- ═══════════════════════════════════════════════════════════════════
-- 016_ap_myob_txn_type.sql
-- Distinguishes which MYOB endpoint an AP invoice was posted to.
--   - 'bill'         → Purchase/Bill/Service (the default — supplier card)
--   - 'spend_money'  → Banking/SpendMoneyTxn (no supplier; clearing/bank
--                      account directly hits the expense). Used when an
--                      invoice doesn't have a MYOB supplier mapped but
--                      has a payment_account_uid set.
-- NULL = legacy / unposted. New posts set this explicitly.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE ap_invoices
  ADD COLUMN IF NOT EXISTS myob_txn_type TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name='ap_invoices' AND constraint_name='ap_invoices_myob_txn_type_check'
  ) THEN
    ALTER TABLE ap_invoices
      ADD CONSTRAINT ap_invoices_myob_txn_type_check
      CHECK (myob_txn_type IS NULL OR myob_txn_type IN ('bill','spend_money'));
  END IF;
END $$;
