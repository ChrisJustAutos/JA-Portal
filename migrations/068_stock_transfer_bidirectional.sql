-- ═══════════════════════════════════════════════════════════════════
-- 068_stock_transfer_bidirectional.sql
-- Status: apply to Supabase project qtiscbvhlvdvafwtdtcd.
--
-- 1. Bi-directional transfers: VPS → JAWS is the mirror of the existing
--    flow — a Sale Invoice (Service) in VPS to a "JAWS" customer card,
--    posted to the same stock-transfer account, plus a Purchase Bill
--    (Item) in JAWS from a "VPS" supplier card that RECEIVES the stock
--    back into JAWS inventory. Two more MYOB references in settings.
-- 2. MechanicDesk PO tracking: a JAWS → VPS transfer also raises +
--    receives a purchase order in MechanicDesk (workshop inventory) via
--    a GitHub-Actions worker; status tracked here.
-- ═══════════════════════════════════════════════════════════════════

-- Reverse-direction MYOB references
ALTER TABLE public.b2b_settings ADD COLUMN IF NOT EXISTS myob_transfer_customer_uid_vps  TEXT;  -- "JAWS" customer card in VPS
ALTER TABLE public.b2b_settings ADD COLUMN IF NOT EXISTS myob_transfer_customer_name_vps TEXT;
ALTER TABLE public.b2b_settings ADD COLUMN IF NOT EXISTS myob_transfer_supplier_uid_jaws  TEXT; -- "VPS" supplier card in JAWS
ALTER TABLE public.b2b_settings ADD COLUMN IF NOT EXISTS myob_transfer_supplier_name_jaws TEXT;

-- Direction + reverse-side document references
ALTER TABLE public.b2b_stock_transfers ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'JAWS_TO_VPS'
  CHECK (direction IN ('JAWS_TO_VPS','VPS_TO_JAWS'));
ALTER TABLE public.b2b_stock_transfers ADD COLUMN IF NOT EXISTS vps_invoice_uid    TEXT;
ALTER TABLE public.b2b_stock_transfers ADD COLUMN IF NOT EXISTS vps_invoice_number TEXT;
ALTER TABLE public.b2b_stock_transfers ADD COLUMN IF NOT EXISTS jaws_bill_uid      TEXT;

-- MechanicDesk PO tracking (JAWS → VPS only)
ALTER TABLE public.b2b_stock_transfers ADD COLUMN IF NOT EXISTS md_po_status     TEXT;  -- queued | created | done | failed
ALTER TABLE public.b2b_stock_transfers ADD COLUMN IF NOT EXISTS md_po_ref        TEXT;  -- MD PO number once created
ALTER TABLE public.b2b_stock_transfers ADD COLUMN IF NOT EXISTS md_po_error      TEXT;
ALTER TABLE public.b2b_stock_transfers ADD COLUMN IF NOT EXISTS md_po_updated_at TIMESTAMPTZ;

-- The MechanicDesk supplier card the workshop's PO is raised on (e.g. the
-- "Just Autos Wholesale" supplier, MD id 1091329). Numeric MD id.
ALTER TABLE public.b2b_settings ADD COLUMN IF NOT EXISTS md_purchase_supplier_id BIGINT;
