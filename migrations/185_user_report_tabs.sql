-- 185: per-user Reports sub-tab allowlist (marketing gets ONLY workshop-map).
-- null / empty = all report tabs (existing behaviour).
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS visible_report_tabs text[];
