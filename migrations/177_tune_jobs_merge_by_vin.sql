-- 177_tune_jobs_merge_by_vin.sql
-- One tune job per VIN (Chris 2026-07-29): remap + lockup-kit Stripe receipts
-- for the same car were creating TWO b2b_tune_jobs — the distributor was
-- asked for the same customer's details twice.
--
-- A second receipt for a VIN with an open (or recently completed) job now
-- MERGES: the primary job gains the receipt's tune details + amount +
-- invoice number, and the receipt is stored as its own row with
-- status 'merged' + merged_into_job_id (so internet_message_id dedup keeps
-- working and the PDF stays on file). Applied via Supabase MCP 2026-07-29.

ALTER TABLE b2b_tune_jobs ADD COLUMN IF NOT EXISTS merged_into_job_id uuid REFERENCES b2b_tune_jobs(id);
CREATE INDEX IF NOT EXISTS b2b_tune_jobs_vin_idx ON b2b_tune_jobs (vin) WHERE vin IS NOT NULL;

-- status gains 'merged' (applied as 177b via MCP)
ALTER TABLE b2b_tune_jobs DROP CONSTRAINT b2b_tune_jobs_status_check;
ALTER TABLE b2b_tune_jobs ADD CONSTRAINT b2b_tune_jobs_status_check
  CHECK (status = ANY (ARRAY['unmatched'::text, 'awaiting_details'::text, 'submitted'::text, 'synced'::text, 'dismissed'::text, 'merged'::text]));
