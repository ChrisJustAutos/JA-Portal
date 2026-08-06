-- 189_mgmt_dashboard_rev_orders_leads.sql
-- Management Dashboard chart 7: Revenue vs Bookings vs Leads — Monthly.
-- Unlike charts 1–6 (JAWS GL bundle) this one reads the VPS company file —
-- the retail/workshop business the sales team quotes for — plus Monday:
--   Revenue  $ = VPS sale invoices, ALL invoice types (credit notes are
--                negative-total invoices so they subtract), ex-GST by default
--                (TotalAmount − TotalTax), bucketed by invoice Date month.
--   Bookings # = COUNT of VPS Sale Orders per Date month (Sale/Order/* across
--                all types). AccountRight deletes an order once converted to
--                an invoice, so past months only show still-open orders.
--   Leads    # = inbound quote-channel leads per created month from the five
--                per-salesperson Monday boards (same boards + intake-creator
--                + quote-item-name filters as the Sales Report; the
--                "Quote - Lead" group filter is deliberately NOT applied —
--                it decays as staff work leads, which would zero history).
-- Rendered as grouped bars with a dual y-axis: Revenue on the left $ axis,
-- Bookings + Leads on a right integer count axis.
-- config.kind 'revenueOrdersLeads' → lib/mgmt-dashboard buildRevenueOrdersLeads;
-- the pull is cached in mgmt_dashboard_cache under
-- 'revOrdersLeads:VPS:2025-01-01' with a 6-hour TTL (backfill months don't
-- change), separate from the 10-min JAWS bundle.
--
-- ON CONFLICT keeps `enabled` as-is (a hidden chart stays hidden on re-run).

INSERT INTO mgmt_dashboard_charts (key, title, chart_type, position, enabled, config) VALUES
('rev_orders_leads', 'Revenue vs Bookings vs Leads — Monthly', 'bars', 7, true, '{
  "kind": "revenueOrdersLeads",
  "startIso": "2025-01-01",
  "revenueBasis": "exGst",
  "entity": "VPS"
}'::jsonb)
ON CONFLICT (key) DO UPDATE SET
  title      = excluded.title,
  chart_type = excluded.chart_type,
  position   = excluded.position,
  config     = excluded.config,
  updated_at = now();
