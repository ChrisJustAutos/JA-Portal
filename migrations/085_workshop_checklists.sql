-- ═══════════════════════════════════════════════════════════════════
-- 085_workshop_checklists.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd ("Just Autos Portal").
--
-- Job-type checklists. A job type can carry a checklist (ordered list of text
-- items); when applied to a booking, the items are copied onto the booking as a
-- tickable checklist shown on the job card. Stored as JSONB:
--   workshop_job_types.checklist  : string[]            (the template items)
--   workshop_bookings.checklist   : {text, done}[]      (per-job, ticked state)
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.workshop_job_types ADD COLUMN IF NOT EXISTS checklist JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.workshop_bookings  ADD COLUMN IF NOT EXISTS checklist JSONB NOT NULL DEFAULT '[]'::jsonb;
