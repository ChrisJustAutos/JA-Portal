-- 175: tune-job payer exclusion list (Chris 2026-07-24: "I dismissed BSC so
-- it should set them to excluded"). Dismissing a job adds its normalised
-- payer name here: every other unmatched job with that name is dismissed in
-- the same click, and future receipts from that payer never create jobs.
create table if not exists b2b_tune_company_exclusions (
  company_raw text primary key,      -- stored lowercased/trimmed (normCompany)
  created_at timestamptz not null default now()
);
alter table b2b_tune_company_exclusions enable row level security;
