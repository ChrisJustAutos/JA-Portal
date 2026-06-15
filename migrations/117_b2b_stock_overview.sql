-- ═══════════════════════════════════════════════════════════════════
-- 117_b2b_stock_overview.sql
-- B2B Stock Overview — a configurable wall of on-hand-quantity tiles for
-- the staff B2B portal. One shared board (singleton row): which catalogue
-- items are pinned (ordered), how many columns, and the colour thresholds
-- (qty below red_below → red; below amber_below → amber).
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.b2b_stock_overview_config (
  id          TEXT PRIMARY KEY DEFAULT 'singleton',
  columns     INT NOT NULL DEFAULT 4,
  red_below   INT NOT NULL DEFAULT 5,
  amber_below INT,                                   -- NULL = no amber band
  item_ids    UUID[] NOT NULL DEFAULT '{}'::uuid[],  -- ordered b2b_catalogue ids
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  UUID REFERENCES public.user_profiles(id)
);
ALTER TABLE public.b2b_stock_overview_config ENABLE ROW LEVEL SECURITY;

INSERT INTO public.b2b_stock_overview_config (id) VALUES ('singleton')
  ON CONFLICT (id) DO NOTHING;
