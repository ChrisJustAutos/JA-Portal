-- ═══════════════════════════════════════════════════════════════════
-- 003_user_preferences.sql
-- Status: ALREADY APPLIED to Supabase project qtiscbvhlvdvafwtdtcd
-- Saved here for reference / disaster recovery only.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  gst_display TEXT NOT NULL DEFAULT 'ex' CHECK (gst_display IN ('inc','ex')),
  default_date_range TEXT NOT NULL DEFAULT 'this_month',
  auto_refresh_seconds INTEGER NOT NULL DEFAULT 0 CHECK (auto_refresh_seconds IN (0, 300, 900, 3600)),
  timezone TEXT NOT NULL DEFAULT 'Australia/Brisbane',
  decimal_precision INTEGER NOT NULL DEFAULT 0 CHECK (decimal_precision IN (0, 2)),
  locale TEXT NOT NULL DEFAULT 'en-AU',
  theme TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark','light','auto')),
  company_logo_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_user_preferences_updated ON user_preferences;
CREATE TRIGGER trg_user_preferences_updated
  BEFORE UPDATE ON user_preferences
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_read_own_prefs" ON user_preferences FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users_write_own_prefs" ON user_preferences FOR ALL USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION get_or_create_preferences(uid UUID)
RETURNS SETOF user_preferences AS $$
BEGIN
  INSERT INTO user_preferences (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING;
  RETURN QUERY SELECT * FROM user_preferences WHERE user_id = uid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
