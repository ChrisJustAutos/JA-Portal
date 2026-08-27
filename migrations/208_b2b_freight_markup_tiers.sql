-- 208_b2b_freight_markup_tiers.sql
--
-- Tiered freight markup (Chris, 2026-08-27): "$500 and under 20%, $1000 and
-- under 10%, $1000 - $3000 5%". A single freight_markup_percent charged the
-- same 20% on a $2,800 consignment as on a $60 one.
--
-- The band is chosen by what the CARRIER charges us (the base price), not by
-- the marked-up sell price -- Chris's call, and the only version that is a
-- calculation rather than a fixed-point solve. The top band is open-ended so
-- no consignment can ever fall through with no markup.
--
-- b2b_settings.freight_markup_percent is LEFT IN PLACE and is still the
-- fallback when this table is empty, so a deploy landing before the migration
-- cannot leave freight unpriceable. Same arrangement as the pallets table.

CREATE TABLE IF NOT EXISTS public.b2b_freight_markup_tiers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Upper bound of the band, INCLUSIVE, on the carrier price ex GST.
  -- NULL = the open-ended top band ("everything above the rest").
  up_to_ex_gst    NUMERIC(10,2),
  markup_percent  NUMERIC(6,2) NOT NULL,
  sort_order      INT NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT b2b_freight_markup_tiers_pct_sane   CHECK (markup_percent >= 0 AND markup_percent <= 500),
  CONSTRAINT b2b_freight_markup_tiers_bound_sane CHECK (up_to_ex_gst IS NULL OR up_to_ex_gst > 0)
);

-- Only ONE open-ended band makes sense; two would make resolution ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS b2b_freight_markup_tiers_one_open_idx
  ON public.b2b_freight_markup_tiers ((up_to_ex_gst IS NULL))
  WHERE up_to_ex_gst IS NULL AND is_active;

CREATE INDEX IF NOT EXISTS b2b_freight_markup_tiers_active_idx
  ON public.b2b_freight_markup_tiers (is_active, up_to_ex_gst);

ALTER TABLE public.b2b_freight_markup_tiers ENABLE ROW LEVEL SECURITY;  -- service-role only

-- Seed Chris's three bands, only when nothing is configured yet.
INSERT INTO public.b2b_freight_markup_tiers (up_to_ex_gst, markup_percent, sort_order)
SELECT * FROM (VALUES
  (500.00::NUMERIC,  20.00::NUMERIC, 10),
  (1000.00::NUMERIC, 10.00::NUMERIC, 20),
  (NULL::NUMERIC,     5.00::NUMERIC, 30)
) AS seed(up_to_ex_gst, markup_percent, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.b2b_freight_markup_tiers);
