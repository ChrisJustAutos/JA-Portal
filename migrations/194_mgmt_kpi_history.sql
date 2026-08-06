-- 194: Management Dashboard KPI history snapshots.
--
-- Tile-click history (Chris 2026-08-07): the FLOW KPIs (revenue / GP / GM /
-- COGS) get a weekly series computed straight off the already-pulled GL
-- window, but the POINT-IN-TIME KPIs (cash in bank, days cash on hand,
-- inventory value, stock:weekly sales, month projections) have no history
-- anywhere — so every FRESH dashboard compute (the nightly 5:30am warm cron
-- plus any manual Refresh) upserts today's Brisbane-date row carrying the
-- full numeric KPI value map. One row per day accrues automatically; the
-- tile history modal reads the most recent ~26.
--
-- Server-only table (service role); RLS enabled with no policies — same as
-- the other mgmt_dashboard_* tables (migration 184).

CREATE TABLE mgmt_dashboard_kpi_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date date NOT NULL UNIQUE,
  kpis          jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mgmt_dashboard_kpi_snapshots ENABLE ROW LEVEL SECURITY;
