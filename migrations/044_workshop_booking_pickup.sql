-- ═══════════════════════════════════════════════════════════════════
-- 044_workshop_booking_pickup.sql
-- Customer pick-up / collection time on a booking. Internal only — shown on
-- the job card; does NOT affect where the booking sits in the diary (that's
-- driven by starts_at/ends_at). Start/end dates+times already live in
-- starts_at/ends_at, which can now span multiple days.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.workshop_bookings
  ADD COLUMN IF NOT EXISTS pickup_at TIMESTAMPTZ;
