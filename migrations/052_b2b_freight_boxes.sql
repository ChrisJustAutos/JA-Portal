-- ═══════════════════════════════════════════════════════════════════
-- 052_b2b_freight_boxes.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd, then kept for reference.
--
-- Editable freight-packaging config for the (upcoming) cartonizer that decides
-- how a multi-item order is packed for a MachShip quote/booking:
--   • b2b_freight_boxes — the standard cartons you ship in (usable internal
--     dims + max weight). Staff manage these in B2B Settings → Freight packaging.
--   • b2b_settings pallet spec + the total-weight threshold above which an
--     order ships on a pallet instead of boxes.
-- Service-role only (managed via the admin API).
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.b2b_freight_boxes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  length_mm     INT NOT NULL,
  width_mm      INT NOT NULL,
  height_mm     INT NOT NULL,
  max_weight_g  INT NOT NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS b2b_freight_boxes_active_idx ON public.b2b_freight_boxes (is_active, sort_order);
ALTER TABLE public.b2b_freight_boxes ENABLE ROW LEVEL SECURITY;  -- service-role only

ALTER TABLE public.b2b_settings
  ADD COLUMN IF NOT EXISTS freight_pallet_length_mm     INT,
  ADD COLUMN IF NOT EXISTS freight_pallet_width_mm      INT,
  ADD COLUMN IF NOT EXISTS freight_pallet_max_height_mm INT,
  ADD COLUMN IF NOT EXISTS freight_pallet_max_weight_g  INT,
  ADD COLUMN IF NOT EXISTS freight_pallet_threshold_g   INT;  -- order weight > this → pallet
