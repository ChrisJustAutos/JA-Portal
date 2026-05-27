-- ═══════════════════════════════════════════════════════════════════
-- 035_workshop_tech_capacity.sql
-- Per-technician daily workload capacity (hours/day) for the diary lanes, so
-- the front desk can see booked-vs-capacity per line and avoid overbooking.
-- One row per technician extension. Service-role-only (RLS on, no policy).
-- (Diary day-notes use the workshop_diary_notes table from migration 032.)
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.workshop_tech_capacity (
  technician_ext TEXT PRIMARY KEY,
  daily_hours    NUMERIC(5,1) NOT NULL DEFAULT 8,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.workshop_tech_capacity ENABLE ROW LEVEL SECURITY;
