-- ═══════════════════════════════════════════════════════════════════
-- 083_workshop_purchase_orders.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd ("Just Autos Portal").
--
-- Workshop Purchase Orders (from the autodesk_pro prototype). Portal-native POs
-- with suppliers + line items, low-stock auto-generation, and an optional push
-- to MYOB AccountRight (Purchase Bill) on receive. Inventory quantities still
-- come from the MYOB sync; POs add the ordering/receiving workflow on top.
--
--   workshop_suppliers        — supplier master (optionally linked to a MYOB card)
--   workshop_purchase_orders  — a PO: draft → sent → received (or cancelled)
--   workshop_po_lines         — PO line items (qty + unit cost)
--
-- RLS enabled, service-role only.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.workshop_suppliers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  contact_name  TEXT,
  phone         TEXT,
  email         TEXT,
  address       TEXT,
  myob_supplier_uid  TEXT,
  myob_supplier_name TEXT,
  notes         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_by    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS workshop_suppliers_name_idx ON public.workshop_suppliers (name);

CREATE TABLE IF NOT EXISTS public.workshop_purchase_orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_seq        BIGINT GENERATED ALWAYS AS IDENTITY,   -- display number: PO-{padded}
  supplier_id   UUID REFERENCES public.workshop_suppliers(id) ON DELETE SET NULL,
  supplier_name TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',          -- draft | sent | received | cancelled
  source        TEXT NOT NULL DEFAULT 'manual',         -- manual | low_stock | booking
  booking_id    UUID REFERENCES public.workshop_bookings(id) ON DELETE SET NULL,
  notes         TEXT,
  subtotal_ex_gst NUMERIC(12,2) NOT NULL DEFAULT 0,
  gst           NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_inc     NUMERIC(12,2) NOT NULL DEFAULT 0,
  expected_at   TIMESTAMPTZ,
  ordered_at    TIMESTAMPTZ,
  received_at   TIMESTAMPTZ,
  myob_bill_uid TEXT,
  myob_bill_number TEXT,
  myob_written_at TIMESTAMPTZ,
  myob_write_error TEXT,
  created_by    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS workshop_po_status_idx ON public.workshop_purchase_orders (status);
CREATE INDEX IF NOT EXISTS workshop_po_supplier_idx ON public.workshop_purchase_orders (supplier_id);

CREATE TABLE IF NOT EXISTS public.workshop_po_lines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id         UUID NOT NULL REFERENCES public.workshop_purchase_orders(id) ON DELETE CASCADE,
  inventory_id  UUID,
  myob_item_uid TEXT,
  sku           TEXT,
  name          TEXT NOT NULL,
  qty           NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit_cost_ex_gst NUMERIC(12,4) NOT NULL DEFAULT 0,
  line_total_ex_gst NUMERIC(12,2) NOT NULL DEFAULT 0,
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workshop_po_lines_po_idx ON public.workshop_po_lines (po_id, sort_order);

-- updated_at triggers (reuse the CRM helper created in migration 079)
DROP TRIGGER IF EXISTS workshop_suppliers_set_updated ON public.workshop_suppliers;
CREATE TRIGGER workshop_suppliers_set_updated BEFORE UPDATE ON public.workshop_suppliers
  FOR EACH ROW EXECUTE FUNCTION public.crm_set_updated_at();
DROP TRIGGER IF EXISTS workshop_po_set_updated ON public.workshop_purchase_orders;
CREATE TRIGGER workshop_po_set_updated BEFORE UPDATE ON public.workshop_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.crm_set_updated_at();

ALTER TABLE public.workshop_suppliers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_po_lines        ENABLE ROW LEVEL SECURITY;
