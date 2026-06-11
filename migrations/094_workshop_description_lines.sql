-- 094_workshop_description_lines.sql
-- New 'description' line type: a text-only heading row that sits BETWEEN
-- priced line items on the job invoice — "Logbook service" then the labour +
-- parts that belong to it. Renders full-width on the job card + PDF, and
-- pushes to MYOB as a Type:'Header' line. Applying a job type now inserts
-- the job type's name as one of these before its template lines.

ALTER TABLE public.workshop_booking_lines
  DROP CONSTRAINT IF EXISTS workshop_booking_lines_line_type_check;
ALTER TABLE public.workshop_booking_lines
  ADD CONSTRAINT workshop_booking_lines_line_type_check
  CHECK (line_type IN ('labour','part','sublet','fee','description'));

ALTER TABLE public.workshop_job_type_lines
  DROP CONSTRAINT IF EXISTS workshop_job_type_lines_line_type_check;
ALTER TABLE public.workshop_job_type_lines
  ADD CONSTRAINT workshop_job_type_lines_line_type_check
  CHECK (line_type IN ('labour','part','sublet','fee','description'));
