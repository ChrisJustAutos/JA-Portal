-- 113: per-technician per-day availability (mark a lane Away / Fully booked).
-- Keyed by technician_code (the diary lane key = workshop_technicians.code).
CREATE TABLE IF NOT EXISTS public.workshop_tech_availability (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_code  TEXT NOT NULL,
  date             DATE NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('away','full')),
  note             TEXT,
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (technician_code, date)
);
CREATE INDEX IF NOT EXISTS workshop_tech_availability_date_idx ON public.workshop_tech_availability(date);
ALTER TABLE public.workshop_tech_availability ENABLE ROW LEVEL SECURITY;
