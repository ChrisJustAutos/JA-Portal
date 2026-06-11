-- 093_workshop_stock_movements.sql
-- Portal-side stock ledger for job finalise / un-finalise.
--
-- Finalise (Invoice → MYOB) now also deducts each part line's qty from
-- workshop_inventory (quantity + available) and records a movement row here.
-- Un-finalise reverses the unreversed rows (adds the qty back) and stamps
-- reversed_at — so a job can only ever be deducted once, and the reversal
-- restores exactly what was taken even if lines changed afterwards.

CREATE TABLE IF NOT EXISTS public.workshop_stock_movements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   UUID NOT NULL REFERENCES public.workshop_bookings(id) ON DELETE CASCADE,
  inventory_id UUID NOT NULL REFERENCES public.workshop_inventory(id) ON DELETE CASCADE,
  line_id      UUID,                       -- workshop_booking_lines.id at deduction time (no FK; lines may be deleted later)
  qty          NUMERIC(12,2) NOT NULL,     -- positive = deducted from stock
  reversed_at  TIMESTAMPTZ,                -- set by un-finalise when the qty was added back
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wsm_booking ON public.workshop_stock_movements (booking_id);

ALTER TABLE public.workshop_stock_movements ENABLE ROW LEVEL SECURITY;
