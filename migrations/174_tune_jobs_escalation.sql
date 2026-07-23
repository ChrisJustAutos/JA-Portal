-- 174: tune-job reminder escalation ladder (Chris 2026-07-24):
--   email first → 7 days unfilled → SMS the distributor → 10 more days → email Ryan.
-- Stage stamps make each rung fire exactly once per job.
alter table b2b_tune_jobs add column if not exists first_reminded_at timestamptz;
alter table b2b_tune_jobs add column if not exists sms_reminded_at timestamptz;
alter table b2b_tune_jobs add column if not exists escalated_at timestamptz;
