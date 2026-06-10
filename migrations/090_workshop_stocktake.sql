-- 090_workshop_stocktake.sql
-- Portal-native stocktake over workshop_inventory (parallel to the existing
-- MechanicDesk stocktake until MD is cancelled). Sessions snapshot system_qty
-- and buy_price per item at start so a mid-count MYOB inventory sync can't
-- shift the goalposts. Apply posts an MYOB Inventory/Adjustment (when posting
-- is enabled) then re-syncs quantities from MYOB.

CREATE TABLE IF NOT EXISTS public.workshop_stocktakes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  st_seq              BIGINT GENERATED ALWAYS AS IDENTITY,   -- display "ST-{n}"
  name                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'counting' CHECK (status IN ('counting', 'review', 'applied', 'cancelled')),
  scope_filter        JSONB,                                 -- { location?, category?, supplier?, q? } — null = full stocktake
  uncounted_policy    TEXT NOT NULL DEFAULT 'keep' CHECK (uncounted_policy IN ('keep', 'zero')),
  item_count          INT NOT NULL DEFAULT 0,
  counted_count       INT NOT NULL DEFAULT 0,
  variance_qty        NUMERIC(14,2),
  variance_value      NUMERIC(14,2),                         -- Σ delta × snapshot buy_price, set at apply
  myob_adjustment_uid TEXT,                                  -- idempotency for the MYOB Inventory/Adjustment
  myob_write_error    TEXT,
  applied_at          TIMESTAMPTZ,
  applied_by          UUID,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.workshop_stocktake_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stocktake_id  UUID NOT NULL REFERENCES public.workshop_stocktakes(id) ON DELETE CASCADE,
  inventory_id  UUID NOT NULL REFERENCES public.workshop_inventory(id) ON DELETE CASCADE,
  myob_uid      TEXT,                                        -- snapshot — survives inventory re-sync
  sku           TEXT,
  part_name     TEXT,
  barcode       TEXT,
  location      TEXT,
  bin           TEXT,
  system_qty    NUMERIC(12,2) NOT NULL DEFAULT 0,            -- on-hand at session start
  buy_price     NUMERIC(12,2) NOT NULL DEFAULT 0,            -- for variance valuation
  counted_qty   NUMERIC(12,2),                               -- NULL = not yet counted
  counted_by    UUID,
  counted_at    TIMESTAMPTZ,
  note          TEXT,
  UNIQUE (stocktake_id, inventory_id)
);
CREATE INDEX IF NOT EXISTS workshop_st_items_idx     ON public.workshop_stocktake_items (stocktake_id);
CREATE INDEX IF NOT EXISTS workshop_st_items_sku_idx ON public.workshop_stocktake_items (stocktake_id, lower(sku));

-- The MYOB account qty variances post against (shrinkage / COGS expense).
ALTER TABLE public.workshop_settings
  ADD COLUMN IF NOT EXISTS inventory_adjust_account_uid  TEXT,
  ADD COLUMN IF NOT EXISTS inventory_adjust_account_name TEXT;

DROP TRIGGER IF EXISTS workshop_st_set_updated ON public.workshop_stocktakes;
CREATE TRIGGER workshop_st_set_updated BEFORE UPDATE ON public.workshop_stocktakes
  FOR EACH ROW EXECUTE FUNCTION public.crm_set_updated_at();

ALTER TABLE public.workshop_stocktakes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_stocktake_items ENABLE ROW LEVEL SECURITY;
