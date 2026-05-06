-- Persist parser warnings on each job-report ingest run so they can be
-- inspected in the UI / via SQL after the fact, instead of disappearing
-- into the upload API response. Empty array == no warnings.
--
-- Applied to Supabase project qtiscbvhlvdvafwtdtcd via apply_migration on
-- 2026-05-07. This file is the tracked copy.

alter table public.job_report_runs
  add column if not exists warnings text[] not null default '{}'::text[];
