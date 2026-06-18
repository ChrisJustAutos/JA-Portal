-- 132_md_prepick_jobs.sql
-- Per-job breakdown for the Pre Pick screen, so we can show (a) all the jobs
-- that need a given part, and (b) a job list where each job expands to the
-- parts applied to it. md_prepick_items (migration 131) stays as the AGGREGATE
-- demand per part; these two tables hold the underlying job ↔ line-item links.
-- Job metadata comes from the MD diary bookings (customer/vehicle/rego/number/
-- date/status); line items come from each job's invoice (tracked parts only).
-- Populated by the same worker run; service-role only (no RLS policies).

create table if not exists public.md_prepick_jobs (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.md_prepick_runs(id) on delete cascade,
  md_job_id     bigint not null,
  job_number    text,
  customer_name text,
  phone         text,
  vehicle       text,
  rego          text,
  status        text,
  description   text,
  scheduled_at  timestamptz,
  parts_count   integer not null default 0,   -- distinct tracked parts on the job
  parts_qty     numeric(12,2) not null default 0
);
create index if not exists md_prepick_jobs_run_idx on public.md_prepick_jobs (run_id);
create index if not exists md_prepick_jobs_run_job_idx on public.md_prepick_jobs (run_id, md_job_id);

create table if not exists public.md_prepick_job_items (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references public.md_prepick_runs(id) on delete cascade,
  md_job_id   bigint not null,
  md_stock_id bigint,
  sku         text,
  name        text,
  quantity    numeric(12,2) not null default 0
);
create index if not exists md_prepick_job_items_run_idx on public.md_prepick_job_items (run_id);
create index if not exists md_prepick_job_items_run_stock_idx on public.md_prepick_job_items (run_id, md_stock_id);
create index if not exists md_prepick_job_items_run_job_idx on public.md_prepick_job_items (run_id, md_job_id);

alter table public.md_prepick_jobs      enable row level security;
alter table public.md_prepick_job_items enable row level security;
