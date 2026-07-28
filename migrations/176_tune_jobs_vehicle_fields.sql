-- 176_tune_jobs_vehicle_fields.sql
-- Distributor tune-job form rework (Chris 2026-07-28):
--   * vehicle captured as Make / Model / Year (same fields as MechanicDesk)
--     instead of a free-text description the MD worker had to guess apart.
--   * customer name becomes ONE "first & last" field on the form; the
--     separate first-name input is gone (customer_first_name is now derived
--     server-side for letter salutations — column unchanged).
-- vehicle_description stays: composed "<year> <make> <model>" for letters
-- and back-compat with rows filled before this change.

ALTER TABLE b2b_tune_jobs
  ADD COLUMN IF NOT EXISTS vehicle_make  text,
  ADD COLUMN IF NOT EXISTS vehicle_model text,
  ADD COLUMN IF NOT EXISTS vehicle_year  text;
