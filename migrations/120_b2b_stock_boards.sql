-- ═══════════════════════════════════════════════════════════════════
-- 120_b2b_stock_boards.sql
-- Saved Stock Wall "views" (presets) — e.g. Airboxes, Exhausts. Each board
-- is its own named, ordered set of products with its own column density and
-- default colour thresholds. Replaces the single shared board for the admin
-- Stock Wall; the existing singleton config is migrated into the first board
-- and is still read by the supplier wall for its default thresholds.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.b2b_stock_boards (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  columns     INT NOT NULL DEFAULT 4,
  red_below   INT NOT NULL DEFAULT 5,
  amber_below INT,
  item_ids    UUID[] NOT NULL DEFAULT '{}'::uuid[],
  sort_order  INT NOT NULL DEFAULT 0,
  created_by  UUID REFERENCES public.user_profiles(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.b2b_stock_boards ENABLE ROW LEVEL SECURITY;

-- Seed the first board from the existing singleton config so nothing is lost.
INSERT INTO public.b2b_stock_boards (name, columns, red_below, amber_below, item_ids, sort_order)
SELECT 'Stock Wall', columns, red_below, amber_below, item_ids, 0
FROM public.b2b_stock_overview_config
WHERE id = 'singleton'
  AND NOT EXISTS (SELECT 1 FROM public.b2b_stock_boards);
