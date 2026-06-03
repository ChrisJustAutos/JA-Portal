-- 073_notif_mute_prefs.sql
-- Status: apply to Supabase project qtiscbvhlvdvafwtdtcd ("Just Autos Portal").
--
-- Per-user notification mute list: module ids (matching DEFAULT_NAV ids, e.g.
-- 'calls', 'b2b', 'messages') the user has switched OFF. Muted modules are
-- hidden from the bell + badges and don't push. Adds one column to the
-- existing user_preferences table.

ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS muted_notif_modules JSONB NOT NULL DEFAULT '[]'::jsonb;
