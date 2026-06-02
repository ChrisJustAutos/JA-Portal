-- 067_stock_transfer_po_ref.sql
-- Status: apply to Supabase project qtiscbvhlvdvafwtdtcd.
-- Optional purchase-order reference on a stock transfer: lands in the JAWS
-- sale invoice's CustomerPurchaseOrderNumber and the VPS bill's
-- SupplierInvoiceNumber so both documents carry the same reference.

ALTER TABLE public.b2b_stock_transfers ADD COLUMN IF NOT EXISTS po_reference TEXT;
