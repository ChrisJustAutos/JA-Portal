-- 190: drop-ship PO → Bill receiving.
--
-- Order B2B-2026-000040 (Torrisi): MYOB refused the Sale Order → Invoice
-- conversion with Inventory_InsufficientStockMultipleLocation because the
-- drop-ship line's stock was never RECEIVED — the supplier PO was still an
-- open purchase order. Converting the PO to a Bill receives the stock into
-- the supplier's DS inventory location, after which the sale conversion (and
-- payment receipting) succeeds.
--
-- Per-PO bill details (myob_bill_uid / myob_bill_number / billed_at) live in
-- the existing b2b_orders.dropship_pos jsonb entries — same place the PO
-- uid/number already live — so no per-PO table columns are needed.

-- Stamped when every raised drop-ship PO on the order has been billed.
alter table b2b_orders add column if not exists dropship_po_billed_at timestamptz;

-- Concurrency claim for the receive/billing run (same conditional-UPDATE
-- pattern as migration 172's claim columns — exactly one runner wins, stale
-- claims from crashed runs self-expire after 10 minutes).
alter table b2b_orders add column if not exists dropship_billing_at timestamptz;
