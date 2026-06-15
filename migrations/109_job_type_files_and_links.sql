-- 109: job-type file attachments + applied-job-type tracking
-- Reuse the workshop-files bucket/table for files attached to a JOB TYPE
-- (reusable template docs, e.g. service checklists, warranty PDFs), and track
-- which job types were applied to a booking/quote so those files can be offered
-- as optional email attachments.

ALTER TABLE workshop_files
  ADD COLUMN IF NOT EXISTS job_type_id UUID REFERENCES workshop_job_types(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS workshop_files_job_type_id_idx ON workshop_files(job_type_id);

CREATE TABLE IF NOT EXISTS workshop_doc_job_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  UUID REFERENCES workshop_bookings(id) ON DELETE CASCADE,
  quote_id    UUID REFERENCES workshop_quotes(id)   ON DELETE CASCADE,
  job_type_id UUID NOT NULL REFERENCES workshop_job_types(id) ON DELETE CASCADE,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by  TEXT,
  CHECK (booking_id IS NOT NULL OR quote_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS workshop_doc_job_types_booking_uniq ON workshop_doc_job_types(booking_id, job_type_id) WHERE booking_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workshop_doc_job_types_quote_uniq   ON workshop_doc_job_types(quote_id, job_type_id)   WHERE quote_id   IS NOT NULL;
ALTER TABLE workshop_doc_job_types ENABLE ROW LEVEL SECURITY;
