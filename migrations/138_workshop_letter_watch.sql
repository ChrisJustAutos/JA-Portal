-- ═══════════════════════════════════════════════════════════════════
-- 138_workshop_letter_watch.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd.
--
-- Supports the MYOB-poll trigger for the thank-you letter automation (jobs are
-- finalised in MechanicDesk → pushed to MYOB; the portal polls VPS invoices).
--   • watch_since — only invoices on/after this fire (set when enabling, so we
--     don't backfill every recent invoice the moment it's turned on)
--   • unique index on (myob_invoice_uid) for auto letters — the poll path has
--     no booking_id, so dedup keys on the MYOB invoice UID instead
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.workshop_letter_automation ADD COLUMN IF NOT EXISTS watch_since TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS workshop_letter_jobs_myob_auto_uidx
  ON public.workshop_letter_jobs (myob_invoice_uid)
  WHERE trigger = 'auto' AND myob_invoice_uid IS NOT NULL;
