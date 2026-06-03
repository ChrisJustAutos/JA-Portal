-- 069_stock_transfer_md_first.sql
-- Status: apply to Supabase project qtiscbvhlvdvafwtdtcd.
--
-- MD-first numbering for JAWS → VPS transfers: MechanicDesk raises the PO and
-- assigns its own sequential PO number, which then becomes the PO reference on
-- the MYOB sale (JAWS) + bill (VPS). So the MD worker now runs BEFORE the MYOB
-- writes (the worker calls back to finalise MYOB once it has the number).
--
-- md_po_id stores the MechanicDesk purchase id so a re-run is idempotent
-- (reuse the existing PO instead of creating a second one).

ALTER TABLE public.b2b_stock_transfers ADD COLUMN IF NOT EXISTS md_po_id BIGINT;

-- 'awaiting_md' = forward transfer created, MD PO + MYOB still to post.
-- (Existing statuses: pending, complete, partial, failed.)
ALTER TABLE public.b2b_stock_transfers DROP CONSTRAINT IF EXISTS b2b_stock_transfers_status_check;
ALTER TABLE public.b2b_stock_transfers ADD CONSTRAINT b2b_stock_transfers_status_check
  CHECK (status IN ('pending','awaiting_md','complete','partial','failed'));
