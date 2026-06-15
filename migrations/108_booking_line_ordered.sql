-- 108: per-part-line ordering on the Orders screen
-- Track ordered state per workshop_booking_lines part row, and which PO it went
-- onto, so parts can be ordered/PO'd individually rather than per whole booking.

ALTER TABLE workshop_booking_lines
  ADD COLUMN IF NOT EXISTS ordered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ordered_by TEXT,
  ADD COLUMN IF NOT EXISTS po_id UUID REFERENCES workshop_purchase_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS workshop_booking_lines_po_id_idx ON workshop_booking_lines(po_id);
