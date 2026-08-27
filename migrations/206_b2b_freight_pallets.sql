-- 206_b2b_freight_pallets.sql
--
-- More than one pallet option (Chris, 2026-08-27). Until now the cartonizer
-- knew exactly ONE pallet, held as five columns on b2b_settings, so an order
-- that wanted a different footprint had nowhere to go.
--
-- Pallets become a table, mirroring b2b_freight_boxes — same shape, same CRUD,
-- same Settings → Freight packaging screen — so adding a third later needs no
-- code at all.
--
-- The palletise-by-weight THRESHOLD stays on b2b_settings: it decides pallet
-- vs cartons for the order as a whole, not which pallet, so it isn't a
-- property of any one pallet.
--
-- The legacy b2b_settings.freight_pallet_* columns are LEFT IN PLACE and are
-- seeded across below. lib/b2b-freight still falls back to them when the table
-- is empty, so a half-applied deploy can't leave freight unquotable.

CREATE TABLE IF NOT EXISTS public.b2b_freight_pallets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  length_mm      INT NOT NULL,
  width_mm       INT NOT NULL,
  max_height_mm  INT NOT NULL,
  max_weight_g   INT NOT NULL,
  sort_order     INT NOT NULL DEFAULT 0,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS b2b_freight_pallets_active_idx
  ON public.b2b_freight_pallets (is_active, sort_order);
ALTER TABLE public.b2b_freight_pallets ENABLE ROW LEVEL SECURITY;  -- service-role only

-- Seed the existing configured pallet as the first row, so behaviour on the
-- day of the deploy is identical to before. Only when the table is empty and
-- a pallet is actually configured.
INSERT INTO public.b2b_freight_pallets (name, length_mm, width_mm, max_height_mm, max_weight_g, sort_order)
SELECT 'Standard pallet',
       s.freight_pallet_length_mm,
       s.freight_pallet_width_mm,
       COALESCE(s.freight_pallet_max_height_mm, 1200),
       s.freight_pallet_max_weight_g,
       0
FROM public.b2b_settings s
WHERE s.freight_pallet_length_mm IS NOT NULL
  AND s.freight_pallet_width_mm IS NOT NULL
  AND s.freight_pallet_max_weight_g IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.b2b_freight_pallets)
LIMIT 1;
