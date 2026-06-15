-- 114: B2B stock reorder / prediction sheet (replaces the JAWS stock-order Excel)
CREATE TABLE IF NOT EXISTS public.b2b_reorder_settings (
  id              TEXT PRIMARY KEY DEFAULT 'singleton',
  from_date       DATE,
  to_date         DATE,
  growth_pct      NUMERIC NOT NULL DEFAULT 0.2,
  forecast_months INT NOT NULL DEFAULT 3,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.b2b_reorder_settings (id) VALUES ('singleton') ON CONFLICT DO NOTHING;
ALTER TABLE public.b2b_reorder_settings ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.b2b_reorder_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku              TEXT NOT NULL UNIQUE,
  name             TEXT,
  on_hand          NUMERIC NOT NULL DEFAULT 0,
  committed        NUMERIC NOT NULL DEFAULT 0,
  on_order         NUMERIC NOT NULL DEFAULT 0,
  available        NUMERIC NOT NULL DEFAULT 0,
  sales_qty        NUMERIC NOT NULL DEFAULT 0,
  moq              INTEGER,
  morgans_judgment NUMERIC,
  notes            TEXT,
  synced_at        TIMESTAMPTZ,
  sort_order       INT NOT NULL DEFAULT 0,
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.b2b_reorder_items ENABLE ROW LEVEL SECURITY;
