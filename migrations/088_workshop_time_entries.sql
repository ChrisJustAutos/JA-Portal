-- 088_workshop_time_entries.sql
-- Time clock: tech clock-on/clock-off per job. One running entry (ended_at
-- NULL) per tech per job, enforced by a partial unique index.

CREATE TABLE IF NOT EXISTS public.workshop_time_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID NOT NULL REFERENCES public.workshop_bookings(id) ON DELETE CASCADE,
  technician_code TEXT NOT NULL,            -- workshop_technicians.code (diary lane key)
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  minutes         INT,                      -- set on clock-off (or manual edit)
  created_by      UUID,                     -- user who tapped the button
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workshop_time_entries_booking_idx
  ON public.workshop_time_entries (booking_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS workshop_time_entries_open_uniq
  ON public.workshop_time_entries (booking_id, technician_code) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS workshop_time_entries_open_idx
  ON public.workshop_time_entries (booking_id) WHERE ended_at IS NULL;

ALTER TABLE public.workshop_time_entries ENABLE ROW LEVEL SECURITY; -- service-role only
