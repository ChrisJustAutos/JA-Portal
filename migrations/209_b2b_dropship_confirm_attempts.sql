-- 209_b2b_dropship_confirm_attempts.sql
--
-- Make a FAILED drop-ship confirmation retryable (Chris, 2026-08-28: "fix the
-- problem so it doesnt happen again").
--
-- B2B-2026-000052 (Weirys) was stranded for two days. MPI's confirmation was
-- matched and classified correctly on 26 Aug 09:43, then MYOB rejected the
-- PO->Bill with "FreightTaxCode is required". That bug was fixed 30 minutes
-- later in fe38a23 - but nothing ever re-ran the email, because the watcher
-- claims each message by (mailbox, graph_message_id) BEFORE acting and treats
-- ANY existing row as "already handled". One transient MYOB error therefore
-- strands an order permanently and silently: no bill, no customer invoice, no
-- tracking to the distributor.
--
-- Same shape as the AP auto-entry trap fixed earlier today. The row count there
-- served as the attempt counter; here there is exactly ONE row per message (the
-- unique index), updated in place, so the counter has to be a column.

ALTER TABLE public.b2b_dropship_confirm_log
  ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.b2b_dropship_confirm_log.attempts IS
  'How many times this message has been processed. Only action=''error'' rows are retried, capped in lib/b2b-dropship-confirm-watch.ts (MAX_CONFIRM_ATTEMPTS).';

-- Existing error rows get a clean slate: they were never retryable, so nothing
-- has "used up" an attempt on them.
UPDATE public.b2b_dropship_confirm_log SET attempts = 1 WHERE attempts IS NULL;
