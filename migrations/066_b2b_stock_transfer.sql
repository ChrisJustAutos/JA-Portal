-- ═══════════════════════════════════════════════════════════════════
-- 066_b2b_stock_transfer.sql
-- Status: apply to Supabase project qtiscbvhlvdvafwtdtcd, then this file
-- is kept here for reference / disaster recovery.
--
-- Internal stock transfer JAWS → VPS:
--   Staff pick catalogue items + quantities; the portal writes a
--   Sale/Invoice/Item in the JAWS company file (to a "VPS" customer card,
--   priced at MYOB average cost — relieves JAWS stock with no margin) and
--   a matching Purchase/Bill/Service in the VPS company file (from a
--   "JAWS" supplier card, posted to a configured stock-transfer account).
--
--   b2b_stock_transfers tracks both MYOB documents; 'partial' means the
--   JAWS invoice landed but the VPS bill failed (retryable from the UI).
--   Service-role only (RLS enabled, no client policies).
-- ═══════════════════════════════════════════════════════════════════

-- ── Settings: the three MYOB references the transfer needs ────────────
ALTER TABLE public.b2b_settings ADD COLUMN IF NOT EXISTS myob_transfer_customer_uid   TEXT;  -- "VPS" customer card in JAWS
ALTER TABLE public.b2b_settings ADD COLUMN IF NOT EXISTS myob_transfer_customer_name  TEXT;
ALTER TABLE public.b2b_settings ADD COLUMN IF NOT EXISTS myob_transfer_supplier_uid   TEXT;  -- "JAWS" supplier card in VPS
ALTER TABLE public.b2b_settings ADD COLUMN IF NOT EXISTS myob_transfer_supplier_name  TEXT;
ALTER TABLE public.b2b_settings ADD COLUMN IF NOT EXISTS myob_transfer_account_uid    TEXT;  -- VPS GL account the bill posts to
ALTER TABLE public.b2b_settings ADD COLUMN IF NOT EXISTS myob_transfer_account_name   TEXT;

-- ── Transfers ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.b2b_stock_transfers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','complete','partial','failed')),
  note                 TEXT,
  line_count           INTEGER NOT NULL DEFAULT 0,
  subtotal_ex_gst      NUMERIC(12,2) NOT NULL DEFAULT 0,
  gst                  NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_inc            NUMERIC(12,2) NOT NULL DEFAULT 0,
  jaws_invoice_uid     TEXT,
  jaws_invoice_number  TEXT,
  vps_bill_uid         TEXT,
  error                TEXT,
  created_by           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at         TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.b2b_stock_transfer_lines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id   UUID NOT NULL REFERENCES public.b2b_stock_transfers(id) ON DELETE CASCADE,
  catalogue_id  UUID REFERENCES public.b2b_catalogue(id) ON DELETE SET NULL,
  myob_item_uid TEXT NOT NULL,
  sku           TEXT NOT NULL,
  name          TEXT NOT NULL,
  qty           NUMERIC(12,2) NOT NULL CHECK (qty > 0),
  unit_cost_ex  NUMERIC(12,4) NOT NULL,
  total_ex      NUMERIC(12,2) NOT NULL,
  is_taxable    BOOLEAN NOT NULL DEFAULT true,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_b2b_stock_transfer_lines_transfer
  ON public.b2b_stock_transfer_lines (transfer_id);
CREATE INDEX IF NOT EXISTS idx_b2b_stock_transfers_created
  ON public.b2b_stock_transfers (created_at DESC);

ALTER TABLE public.b2b_stock_transfers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.b2b_stock_transfer_lines ENABLE ROW LEVEL SECURITY;
-- No policies: access is exclusively through service-role API routes.
