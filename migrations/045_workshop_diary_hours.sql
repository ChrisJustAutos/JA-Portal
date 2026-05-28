-- ═══════════════════════════════════════════════════════════════════
-- 045_workshop_diary_hours.sql
-- Configurable workshop opening hours for the diary time grid, in minutes
-- from midnight (e.g. 7:00 = 420, 17:30 = 1050). Defaults 7:00–18:00.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.workshop_settings
  ADD COLUMN IF NOT EXISTS diary_start_min INT NOT NULL DEFAULT 420,
  ADD COLUMN IF NOT EXISTS diary_end_min   INT NOT NULL DEFAULT 1080;
