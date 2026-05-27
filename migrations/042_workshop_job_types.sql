-- ═══════════════════════════════════════════════════════════════════
-- 042_workshop_job_types.sql
-- Job-type presets: a named job (e.g. "Logbook Service") with template lines
-- of labour + inventory parts. Applying a job type to a booking copies its
-- lines into workshop_booking_lines. Managed in Workshop Settings; importable
-- from the MechanicDesk job-type export (md_id keeps the trace).
-- Service-role-only (RLS on, no policy).
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.workshop_job_types (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  code                 TEXT UNIQUE,
  description          TEXT,
  default_duration_min INT,
  active               BOOLEAN NOT NULL DEFAULT true,
  sort_order           INT NOT NULL DEFAULT 0,
  md_id                TEXT,                       -- original MechanicDesk id (import trace)
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.workshop_job_type_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type_id       UUID NOT NULL REFERENCES public.workshop_job_types(id) ON DELETE CASCADE,
  line_type         TEXT NOT NULL DEFAULT 'labour' CHECK (line_type IN ('labour','part','sublet','fee')),
  description       TEXT,
  part_number       TEXT,
  qty               NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit_price_ex_gst NUMERIC(12,2) NOT NULL DEFAULT 0,
  gst_rate          NUMERIC(5,4) NOT NULL DEFAULT 0.10,
  inventory_id      UUID REFERENCES public.workshop_inventory(id) ON DELETE SET NULL,
  sort_order        INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS workshop_job_type_lines_idx ON public.workshop_job_type_lines (job_type_id, sort_order);

ALTER TABLE public.workshop_job_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_job_type_lines ENABLE ROW LEVEL SECURITY;
