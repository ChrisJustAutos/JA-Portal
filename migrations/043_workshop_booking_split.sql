-- ═══════════════════════════════════════════════════════════════════
-- 043_workshop_booking_split.sql
-- Splitting a booking creates a sibling booking (same customer/vehicle/job)
-- you can assign to another technician or time — e.g. a job worked by two
-- techs, or split across the day. Siblings share split_group_id so they're
-- recognisably the same visit.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.workshop_bookings
  ADD COLUMN IF NOT EXISTS split_group_id UUID;
CREATE INDEX IF NOT EXISTS workshop_bookings_split_idx ON public.workshop_bookings (split_group_id);
