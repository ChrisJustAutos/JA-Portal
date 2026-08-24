-- 199_jaws_stock_eom.sql
-- Month-end stock snapshots for the JAWS company file (Reports → Stock EOM).
--
-- The /stock page already computes the live picture from MYOB. What it can't do
-- is compare months, because nothing was ever stored — MYOB gives you today's
-- on-hand and no history. So each month-end run freezes its numbers here: the
-- headline metrics as real columns (so a 12-month trend is one cheap query) and
-- the full report, including its bounded top/bottom lists, as jsonb.
--
-- One row per reported month. Re-running a month overwrites it (the operator can
-- force a refresh), which is why `generated_at` matters — it records when the
-- stock position was actually read.
--
-- ⚠ On-hand quantities are always "as at generation time", never as at the last
-- day of the month: AccountRight's Item endpoint exposes only current quantity.
-- The cron runs early on the 1st (Brisbane) to keep the gap small, and the
-- report states the read time on its face.
create table if not exists jaws_stock_snapshots (
  month               text primary key,          -- 'YYYY-MM' being reported
  generated_at        timestamptz not null default now(),
  generated_by        uuid,                      -- null when the cron built it

  -- stock position at read time
  skus                integer,
  stock_value         numeric,
  qty_on_hand         numeric,
  qty_on_order        numeric,
  qty_committed       numeric,

  -- the reported month's trading
  month_units         numeric,
  month_revenue_ex    numeric,
  month_cogs          numeric,
  month_margin        numeric,
  month_margin_pct    numeric,

  -- efficiency
  turns_annualised    numeric,                   -- 12m COGS / stock value
  days_inventory      numeric,                   -- 365 / turns

  -- exception counts
  low_stock_count     integer,
  out_of_stock_count  integer,
  dead_90_count       integer,
  dead_90_value       numeric,
  dead_180_count      integer,
  dead_180_value      numeric,
  never_sold_count    integer,
  never_sold_value    numeric,
  overstock_count     integer,
  overstock_value     numeric,
  reorder_count       integer,
  reorder_cost        numeric,

  payload             jsonb not null             -- full report + bounded lists
);

create index if not exists jse_generated_idx on jaws_stock_snapshots (generated_at desc);
