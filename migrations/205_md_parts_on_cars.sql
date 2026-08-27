-- 205_md_parts_on_cars.sql
--
-- "Parts on cars" checker for Stocktake (MD). During a stocktake the shelf
-- count comes up short because parts are already fitted to cars whose jobs
-- haven't been invoiced yet — MD (and MYOB behind it) still counts them as
-- on-hand. This snapshot names them, so a variance is explainable instead of
-- being re-counted three times.
--
-- WHAT COUNTS (Chris, 2026-08-27): a STARTED job — the car is actually here.
-- In MD terms, diary status `new` with a date that has arrived, whose invoice
-- is not yet finalized, carrying tracked stock lines. Explicitly NOT counted:
-- status `preparing`, which is MD's forward forecast (jobs booked ahead with
-- parts prepped) — those parts may be off the shelf but the car is not in.
--
-- WHY A SNAPSHOT: MD has no usable jobs-list endpoint (/auto_workshop/* 404,
-- /jobs.json 504s), so the only enumeration is a day-by-day diary sweep from a
-- GitHub-Actions Playwright worker — same pattern as Pre Pick (migrations
-- 131/132), which this deliberately mirrors. Probed 2026-08-27: the oldest
-- started job was 209 days old, so the worker sweeps a year back.

create table if not exists public.md_oncar_runs (
  id             uuid primary key default gen_random_uuid(),
  status         text not null default 'pending' check (status in ('pending','running','done','error')),
  from_date      date,                                -- oldest diary day swept
  to_date        date,                                -- newest (always "today")
  days_swept     integer not null default 0,
  days_failed    integer not null default 0,          -- diary days that didn't return 200
  jobs_scanned   integer not null default 0,          -- non-finished jobs opened
  jobs_count     integer not null default 0,          -- jobs that qualified
  items_count    integer not null default 0,          -- distinct SKUs on those jobs
  units_total    numeric(12,2) not null default 0,
  value_total    numeric(14,2) not null default 0,    -- Σ units × MD buy_price
  error          text,
  requested_by   text,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz
);
create index if not exists md_oncar_runs_recent_idx on public.md_oncar_runs (created_at desc);

-- Aggregate per SKU: how many units are sitting on cars right now.
create table if not exists public.md_oncar_items (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references public.md_oncar_runs(id) on delete cascade,
  md_stock_id  bigint,
  sku          text,
  name         text,
  on_cars      numeric(12,2) not null default 0,   -- units across qualifying jobs
  jobs_count   integer not null default 0,         -- how many cars it's spread over
  on_hand      numeric(12,2),                      -- MD quantity at pull time
  available    numeric(12,2),                      -- MD available_quantity (on_hand − allocated)
  buy_price    numeric(12,2),
  bin          text,
  location     text
);
create index if not exists md_oncar_items_run_idx on public.md_oncar_items (run_id);
create index if not exists md_oncar_items_sku_idx on public.md_oncar_items (run_id, lower(sku));

-- One row per qualifying job — so a SKU can be drilled down to "which car".
create table if not exists public.md_oncar_jobs (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references public.md_oncar_runs(id) on delete cascade,
  md_job_id      bigint not null,
  job_number     text,
  customer_name  text,
  vehicle        text,
  rego           text,
  description    text,
  diary_status   text,                              -- 'new' for everything we keep
  invoice_number text,
  scheduled_at   timestamptz,                       -- the diary day the car came in
  days_open      integer,                           -- age in days at pull time
  parts_count    integer not null default 0,
  parts_qty      numeric(12,2) not null default 0,
  parts_value    numeric(14,2) not null default 0
);
create index if not exists md_oncar_jobs_run_idx on public.md_oncar_jobs (run_id);
create index if not exists md_oncar_jobs_run_job_idx on public.md_oncar_jobs (run_id, md_job_id);

-- The job ↔ part links behind both views above.
create table if not exists public.md_oncar_job_items (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references public.md_oncar_runs(id) on delete cascade,
  md_job_id   bigint not null,
  md_stock_id bigint,
  sku         text,
  name        text,
  quantity    numeric(12,2) not null default 0
);
create index if not exists md_oncar_job_items_run_idx on public.md_oncar_job_items (run_id);
create index if not exists md_oncar_job_items_stock_idx on public.md_oncar_job_items (run_id, md_stock_id);
create index if not exists md_oncar_job_items_job_idx on public.md_oncar_job_items (run_id, md_job_id);

-- Service-role only (worker ingest + server-side reads), same as Pre Pick.
alter table public.md_oncar_runs      enable row level security;
alter table public.md_oncar_items     enable row level security;
alter table public.md_oncar_jobs      enable row level security;
alter table public.md_oncar_job_items enable row level security;
