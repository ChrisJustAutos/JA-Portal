-- ═══════════════════════════════════════════════════════════════════
-- 026_b2b_catalogue_supplier.sql
-- Primary supplier per catalogue item (for drop-ship purchase orders).
--
-- MYOB exposes the item's reorder supplier at
--   BuyingDetails.RestockingInformation.Supplier { UID, Name }
-- plus SupplierItemNumber. We mirror those onto b2b_catalogue (MYOB-
-- canonical — refreshed on every catalogue sync) so a drop-ship order
-- line knows which supplier to raise a PO against. Backfilled here from
-- the snapshots we already store, so no re-sync is required.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.b2b_catalogue
  ADD COLUMN IF NOT EXISTS myob_supplier_uid    TEXT,
  ADD COLUMN IF NOT EXISTS myob_supplier_name   TEXT,
  ADD COLUMN IF NOT EXISTS supplier_item_number TEXT;

UPDATE public.b2b_catalogue SET
  myob_supplier_uid    = myob_snapshot->'BuyingDetails'->'RestockingInformation'->'Supplier'->>'UID',
  myob_supplier_name   = myob_snapshot->'BuyingDetails'->'RestockingInformation'->'Supplier'->>'Name',
  supplier_item_number = myob_snapshot->'BuyingDetails'->'RestockingInformation'->>'SupplierItemNumber'
WHERE myob_snapshot IS NOT NULL;

CREATE INDEX IF NOT EXISTS b2b_catalogue_supplier_idx
  ON public.b2b_catalogue (myob_supplier_uid)
  WHERE myob_supplier_uid IS NOT NULL;
