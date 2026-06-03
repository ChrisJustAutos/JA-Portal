-- 073_notif_mute_prefs.sql
-- Status: apply to Supabase project qtiscbvhlvdvafwtdtcd.
--
-- Consolidated user_preferences setup. The table was found MISSING on this
-- project (migrations 003/010/023/024/025 never applied here), so this creates
-- it with EVERY column the app expects, and adds the new notification-mute
-- column. Fully idempotent — safe to run whether or not the table/columns
-- already exist. The preferences API uses the service-role key, so RLS just
-- needs to be enabled (own-row policies added for any direct access).

CREATE TABLE IF NOT EXISTS public.user_preferences (
  user_id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  gst_display          TEXT    NOT NULL DEFAULT 'ex',
  default_date_range   TEXT    NOT NULL DEFAULT 'this_month',
  auto_refresh_seconds INTEGER NOT NULL DEFAULT 0,
  timezone             TEXT    NOT NULL DEFAULT 'Australia/Brisbane',
  decimal_precision    INTEGER NOT NULL DEFAULT 0,
  locale               TEXT    NOT NULL DEFAULT 'en-AU',
  theme                TEXT    NOT NULL DEFAULT 'dark',
  company_logo_url     TEXT,
  accent_color         TEXT    NOT NULL DEFAULT 'blue',
  theme_preset         TEXT    NOT NULL DEFAULT 'midnight',
  nav_groups           JSONB   NOT NULL DEFAULT '[]'::jsonb,
  app_labels           JSONB   NOT NULL DEFAULT '{}'::jsonb,
  launcher_order       JSONB   NOT NULL DEFAULT '[]'::jsonb,
  order_status_groups  JSONB   NOT NULL DEFAULT '[]'::jsonb,
  muted_notif_modules  JSONB   NOT NULL DEFAULT '[]'::jsonb,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

-- Backfill any columns that might be missing if the table partially existed.
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS accent_color        TEXT  NOT NULL DEFAULT 'blue';
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS theme_preset        TEXT  NOT NULL DEFAULT 'midnight';
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS nav_groups          JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS app_labels          JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS launcher_order      JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS order_status_groups JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS muted_notif_modules JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_read_own_prefs ON public.user_preferences;
CREATE POLICY users_read_own_prefs  ON public.user_preferences FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS users_write_own_prefs ON public.user_preferences;
CREATE POLICY users_write_own_prefs ON public.user_preferences FOR ALL USING (auth.uid() = user_id);
