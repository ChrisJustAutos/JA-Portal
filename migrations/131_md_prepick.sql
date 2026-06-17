-- 131_md_prepick.sql
-- Pre Pick snapshots pulled LIVE from MechanicDesk (until the portal replaces
-- MD). A GitHub-Actions worker logs into MD, lists the diary jobs for a date
-- range, fetches each job's invoice line-items, sums the TRACKED parts by stock
-- and records the live on-hand — then POSTs the aggregate here. The Pre Pick
-- screen reads the latest run. (MD's headless-browser session can't run from
-- Vercel, hence the worker + snapshot pattern, same as stocktake.)

create table if not exists public.md_prepick_runs (
  id            uuid primary key default gen_random_uuid(),
  from_date     date not null,
  to_date       date not null,
  status        text not null default 'pending' check (status in ('pending','running','done','error')),
  jobs_count    integer not null default 0,
  items_count   integer not null default 0,
  error         text,
  requested_by  text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index if not exists md_prepick_runs_recent_idx on public.md_prepick_runs (created_at desc);

create table if not exists public.md_prepick_items (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references public.md_prepick_runs(id) on delete cascade,
  md_stock_id    bigint,
  sku            text,
  name           text,
  to_pick        numeric(12,2) not null default 0,   -- summed demand across jobs in range
  on_hand        numeric(12,2) not null default 0,   -- live MD quantity at pull time
  alert_qty      numeric(12,2),                      -- MD alert_quantity (low threshold)
  reorder_point  numeric(12,2),
  buy_price      numeric(12,2),
  location       text
);
create index if not exists md_prepick_items_run_idx on public.md_prepick_items (run_id);

alter table public.md_prepick_runs  enable row level security;
alter table public.md_prepick_items enable row level security;
