-- ═══════════════════════════════════════════════════════════════════
-- 011_ap_triage_override.sql
-- Persistent triage override on ap_invoices: lets an editor force the
-- effective triage_status to 'green' even when natural triage would
-- come back yellow (e.g. no PO on invoice, supplier not mapped).
-- applyTriageAndResolve will honour this column — see lib/ap-supabase.ts.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE ap_invoices
  ADD COLUMN IF NOT EXISTS triage_override TEXT,
  ADD COLUMN IF NOT EXISTS triage_override_reason TEXT,
  ADD COLUMN IF NOT EXISTS triage_override_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS triage_override_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name='ap_invoices' AND constraint_name='ap_invoices_triage_override_check'
  ) THEN
    ALTER TABLE ap_invoices
      ADD CONSTRAINT ap_invoices_triage_override_check
      CHECK (triage_override IS NULL OR triage_override IN ('green'));
  END IF;
END $$;
