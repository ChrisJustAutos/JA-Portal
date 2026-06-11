-- 095_workshop_prepared_status.sql
-- New 'prepared' booking status — the floor stage between Booked and Started
-- (parts picked / job card ready before the vehicle arrives). Completes the
-- quick four-stage flow staff flip through on the diary:
-- Booked → Prepared → Started → Finished, each with its own chip colour.

ALTER TABLE public.workshop_bookings DROP CONSTRAINT IF EXISTS workshop_bookings_status_check;
ALTER TABLE public.workshop_bookings ADD CONSTRAINT workshop_bookings_status_check
  CHECK (status IN ('prebooked','booking','confirmed','prepared','in_progress','awaiting_parts','ready','done','invoiced','paid','cancelled','no_show'));
