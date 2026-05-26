-- ═══════════════════════════════════════════════════════════════════
-- 027_b2b_orders_dropship_pos.sql
-- Track drop-ship purchase orders raised against a B2B order.
--
-- dropship_pos is a list of { supplier_uid, supplier_name, myob_po_uid,
-- myob_po_number, line_count, created_at } — one entry per supplier PO
-- raised for the order's drop-ship lines. dropship_po_raised_at stamps
-- the first time POs were raised (used to gate the button / require
-- ?force to re-raise).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.b2b_orders
  ADD COLUMN IF NOT EXISTS dropship_pos          JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS dropship_po_raised_at TIMESTAMPTZ;
