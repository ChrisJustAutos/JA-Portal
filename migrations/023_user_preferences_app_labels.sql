-- ═══════════════════════════════════════════════════════════════════
-- 023_user_preferences_app_labels.sql
-- Per-user custom names for launcher app tiles.
--
-- Mirrors nav_groups: a per-user jsonb bag, this one mapping an app id
-- (the nav-item id, e.g. 'leads', 'ap') to a custom display label. The
-- launcher, top bar and Apps overlay fall back to the built-in label
-- when there's no override. Empty object = no custom names.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS app_labels JSONB NOT NULL DEFAULT '{}'::jsonb;
