-- ═══════════════════════════════════════════════════════════════════
-- 024_user_preferences_launcher_order.sql
-- Per-user ordering of launcher tiles.
--
-- An ordered list of "cell" ids: app ids (nav-item ids like 'leads')
-- and folder ids ('grp_…' from nav_groups). The home launcher renders
-- cells in this order; anything not listed falls back to the default
-- order (folders first, then apps) appended at the end. Empty = default.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS launcher_order JSONB NOT NULL DEFAULT '[]'::jsonb;
