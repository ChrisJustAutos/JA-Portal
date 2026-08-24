-- 202_jaws_stock_eom_history_window.sql
--
-- JAWS Stock EOM (Chris, 2026-08-25): the sales-history window is now chosen on
-- the report — "pull historical sales data from here to here" — and drives the
-- average sale figures, months-of-cover, and the growth/decline read. Default
-- is the 12 months ending with the reported month; 36 months is the cap.
--
-- The window has to be stored beside the figures: without it, an average or a
-- growth percentage in an old snapshot can't be interpreted.

alter table jaws_stock_snapshots
  add column if not exists history_from           text,
  add column if not exists history_to             text,
  add column if not exists history_months         integer,
  add column if not exists avg_monthly_revenue_ex numeric,
  add column if not exists sales_growth_pct       numeric;

comment on column jaws_stock_snapshots.history_from is
  'First month (YYYY-MM) of the sales-history window this snapshot''s averages, months-of-cover and growth were measured over.';
comment on column jaws_stock_snapshots.sales_growth_pct is
  'Back half of the history window against the front half, on ex-GST revenue. Null when the window is under 4 months.';
