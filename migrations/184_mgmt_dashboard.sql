-- 184_mgmt_dashboard.sql
-- Management Dashboard (Reports → Management Dashboard, JAWS entity).
-- Rebuilds JAWS_Management_Dashboard_0208.xlsx as a live report: 6 charts +
-- KPI cards, all computed from MYOB JAWS data (GL journal lines, sale
-- invoices, inventory items, chart of accounts).
--
-- mgmt_dashboard_charts holds one row per chart PLUS a 'kpis' row (position 0)
-- for the KPI-card engine. Every judgment rule the workbook hardcoded lives in
-- config jsonb so it is editable from the UI:
--   - revenueScope / cogsScope: account prefix + excluded codes
--   - exclusions: B2B intercompany rule (invoice "ID No." contains B2B, or the
--     stock-transfer memo) — the "EX VPS STOCK TRANSFERS" in the title
--   - tuningAccounts + tuningCosPct 0.40: booked 5-* COGS carries no tuning
--     cost, so tuning COS is estimated at 40% of tuning revenue (60% GP)
--   - category account groups, pie part-type account map, cash accounts, top-N
-- config.kind tells lib/mgmt-dashboard which computation to run; everything
-- else parameterises it.
--
-- mgmt_dashboard_cache stores the expensive MYOB pulls (GL + invoices + items
-- + accounts bundle); served when <10 min old unless ?refresh=1.
--
-- Server-only tables (service role); RLS enabled with no policies.

CREATE TABLE mgmt_dashboard_charts (
  key        text PRIMARY KEY,
  title      text NOT NULL,
  chart_type text NOT NULL,                 -- bars | stackedBars | pie | hbar | kpis
  position   int  NOT NULL DEFAULT 0,
  enabled    boolean NOT NULL DEFAULT true,
  config     jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mgmt_dashboard_cache (
  key          text PRIMARY KEY,
  payload      jsonb,
  refreshed_at timestamptz
);

ALTER TABLE mgmt_dashboard_charts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mgmt_dashboard_cache  ENABLE ROW LEVEL SECURITY;

-- ── KPI cards engine (position 0, not rendered as a chart) ──────────────
INSERT INTO mgmt_dashboard_charts (key, title, chart_type, position, enabled, config) VALUES
('kpis', 'KPI cards', 'kpis', 0, true, '{
  "kind": "kpis",
  "revenueScope": { "prefix": "4-", "exclude": ["4-9999", "4-9998", "4-3500", "4-0004"] },
  "cogsScope":    { "prefix": "5-", "exclude": ["5-5999", "5-9998", "5-9999", "5-7000"] },
  "expensePrefix": "6-",
  "tuningAccounts": ["4-1811", "4-1905", "4-1910", "4-1915", "4-1920"],
  "tuningCosPct": 0.40,
  "cashAccounts": ["1-0001", "1-1110", "1-1115", "1-1120"],
  "exclusions": { "invoiceNumberPattern": "B2B", "memoPattern": "Stock transfer.*JA Portal" },
  "headlineTemplate": "Revenue {wow} WoW to {weekRevenue}; GP {gpWow} at {weekGm} margin. Cash {cash}; inventory {inventory} ({stockRatio}x weekly sales). Month tracking to {projectedMonth} at {mtdGm} GM."
}'::jsonb);

-- ── Chart 1: Rolling 7-Day Revenue and Gross Profit ─────────────────────
-- 5 Mon–Sun weekly buckets ending at the week of the latest GL transaction.
-- GP = revenue − booked COGS − tuningCosPct × tuning revenue.
INSERT INTO mgmt_dashboard_charts (key, title, chart_type, position, enabled, config) VALUES
('rolling_revenue_gp', 'Rolling 7-Day Revenue and Gross Profit', 'bars', 1, true, '{
  "kind": "weeklyRevenueGp",
  "weeks": 5,
  "revenueScope": { "prefix": "4-", "exclude": ["4-9999", "4-9998", "4-3500", "4-0004"] },
  "cogsScope":    { "prefix": "5-", "exclude": ["5-5999", "5-9998", "5-9999", "5-7000"] },
  "tuningAccounts": ["4-1811", "4-1905", "4-1910", "4-1915", "4-1920"],
  "tuningCosPct": 0.40,
  "exclusions": { "invoiceNumberPattern": "B2B", "memoPattern": "Stock transfer.*JA Portal" },
  "valueFormat": "currency"
}'::jsonb);

-- ── Chart 2: Revenue Mix — Current 7 Days vs MTD ────────────────────────
-- Category revenue from GL lines classified per income account (replaces the
-- workbook''s dominant-invoice-line hack). "Other" is real accounts (freight,
-- merch, discounts, EFT fee, misc), not a reconciliation plug; Parts = the
-- rest of revenue scope.
INSERT INTO mgmt_dashboard_charts (key, title, chart_type, position, enabled, config) VALUES
('revenue_mix_week_vs_mtd', 'Revenue Mix — Current 7 Days vs MTD', 'bars', 2, true, '{
  "kind": "categoryCompare",
  "windows": [
    { "kind": "currentWeek", "name": "Current 7 Days" },
    { "kind": "mtd",         "name": "MTD" }
  ],
  "categories": [
    { "name": "Parts",  "rest": true },
    { "name": "Tuning", "accounts": ["4-1811", "4-1905", "4-1910", "4-1915", "4-1920"] },
    { "name": "Oil",    "accounts": ["4-1060"] },
    { "name": "Other",  "accounts": ["4-0002", "4-0400", "4-1000", "4-1010", "4-1050", "4-1124", "4-5000"] }
  ],
  "revenueScope": { "prefix": "4-", "exclude": ["4-9999", "4-9998", "4-3500", "4-0004"] },
  "exclusions": { "invoiceNumberPattern": "B2B", "memoPattern": "Stock transfer.*JA Portal" },
  "valueFormat": "currency"
}'::jsonb);

-- ── Chart 3: What's Driving Revenue — Weekly Category Mix ───────────────
-- Same category engine as chart 2, stacked across the same 5 weekly buckets
-- as chart 1. Workbook charts only Parts/Tuning/Oil here (no Other series).
INSERT INTO mgmt_dashboard_charts (key, title, chart_type, position, enabled, config) VALUES
('weekly_category_mix', 'What''s Driving Revenue — Weekly Category Mix', 'stackedBars', 3, true, '{
  "kind": "weeklyCategoryStack",
  "weeks": 5,
  "categories": [
    { "name": "Parts",  "rest": true },
    { "name": "Tuning", "accounts": ["4-1811", "4-1905", "4-1910", "4-1915", "4-1920"] },
    { "name": "Oil",    "accounts": ["4-1060"] }
  ],
  "revenueScope": { "prefix": "4-", "exclude": ["4-9999", "4-9998", "4-3500", "4-0004"] },
  "exclusions": { "invoiceNumberPattern": "B2B", "memoPattern": "Stock transfer.*JA Portal" },
  "valueFormat": "currency"
}'::jsonb);

-- ── Chart 4: Top 10 Inventory Items by Value ────────────────────────────
-- On-hand value = QuantityOnHand × AverageCost per item (Inventory/Item),
-- sorted desc — replaces the LARGE/INDEX-MATCH over the pasted Inventory
-- Value Reconciliation (and its duplicate-value tie bug).
INSERT INTO mgmt_dashboard_charts (key, title, chart_type, position, enabled, config) VALUES
('top_inventory_value', 'Top 10 Inventory Items by Value', 'bars', 4, true, '{
  "kind": "topInventory",
  "topN": 10,
  "valueFormat": "currency"
}'::jsonb);

-- ── Chart 5: Parts Sales Breakdown — Current Week ───────────────────────
-- Trailing-7-day revenue per named part-type income account (window ends at
-- the latest GL transaction date). "Other Parts" = total parts revenue
-- (revenue scope minus tuning minus oil) minus ALL 12 named part-type
-- accounts (partTypeAccounts), floored at 0 — only 5 named slices charted.
INSERT INTO mgmt_dashboard_charts (key, title, chart_type, position, enabled, config) VALUES
('parts_sales_pie', 'Parts Sales Breakdown — Current Week', 'pie', 5, true, '{
  "kind": "accountPie",
  "windowDays": 7,
  "slices": [
    { "label": "Airbox",               "accounts": ["4-1401"] },
    { "label": "Fan Kit",              "accounts": ["4-1802"] },
    { "label": "Heat Exchanger",       "accounts": ["4-1803"] },
    { "label": "Intake Pipe (FJA300)", "accounts": ["4-1805"] },
    { "label": "FJA300 Sump",          "accounts": ["4-1861"] }
  ],
  "otherLabel": "Other Parts",
  "partTypeAccounts": {
    "Airbox": "4-1401", "Exhaust": "4-1602", "Snorkel": "4-1701",
    "Fan Kit": "4-1802", "Heat Exchanger": "4-1803", "Intake Pipe (FJA300)": "4-1805",
    "Filter Guard": "4-1807", "Intake Pipe (VDJ70)": "4-1813", "JA Turbo": "4-1814",
    "Genuine Part": "4-1821", "FJA300 Sump": "4-1861", "Badges": "4-2010"
  },
  "partsExclude": {
    "tuningAccounts": ["4-1811", "4-1905", "4-1910", "4-1915", "4-1920"],
    "oilAccounts": ["4-1060"]
  },
  "revenueScope": { "prefix": "4-", "exclude": ["4-9999", "4-9998", "4-3500", "4-0004"] },
  "exclusions": { "invoiceNumberPattern": "B2B", "memoPattern": "Stock transfer.*JA Portal" },
  "valueFormat": "currency"
}'::jsonb);

-- ── Chart 6: Top 10 Customers by Revenue (MTD, excl. intercompany) ──────
-- From live sale invoices (all types incl. credit notes), ex-GST
-- (TotalAmount − TotalTax) — one basis, fixing the workbook''s inc-GST
-- mismatch, stale SUMIFS range, stale manual rank order, and split
-- name-variant cards (aliasMerge + " (Tuning)" card merge).
INSERT INTO mgmt_dashboard_charts (key, title, chart_type, position, enabled, config) VALUES
('top_customers', 'Top 10 Customers by Revenue (MTD, excl. Intercompany)', 'hbar', 6, true, '{
  "kind": "topCustomers",
  "topN": 10,
  "window": { "kind": "mtd" },
  "basis": "exGst",
  "excludeCustomers": ["Vehicle Performance Solutions T/A Just Autos"],
  "excludeCustomerPatterns": ["stripe"],
  "aliasMerge": {
    "Motorsport, Torrisi": "Torrisi Motorsport",
    "Diesel, Weirys": "Weirys Diesel & Mechanical Services"
  },
  "mergeTuningVariants": true,
  "exclusions": { "invoiceNumberPattern": "B2B", "memoPattern": "Stock transfer.*JA Portal" },
  "valueFormat": "currency"
}'::jsonb);
