-- 096_workshop_parts_ordered.sql
-- Parts-ordering workflow: bookings carry a "parts ordered" mark so the new
-- Orders screen (/workshop/orders) can list upcoming jobs whose parts haven't
-- been ordered yet. Marking is just a timestamp + who — unmark sets it null.

ALTER TABLE public.workshop_bookings
  ADD COLUMN IF NOT EXISTS parts_ordered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS parts_ordered_by TEXT;
