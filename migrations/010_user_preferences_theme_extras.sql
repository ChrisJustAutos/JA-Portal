-- ═══════════════════════════════════════════════════════════════════
-- 010_user_preferences_theme_extras.sql
-- Adds accent_color + theme_preset to user_preferences so the General
-- tab can offer a richer theme picker (accent colour + named preset).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS accent_color TEXT NOT NULL DEFAULT 'blue',
  ADD COLUMN IF NOT EXISTS theme_preset TEXT NOT NULL DEFAULT 'midnight';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name='user_preferences' AND constraint_name='user_preferences_accent_color_check'
  ) THEN
    ALTER TABLE user_preferences
      ADD CONSTRAINT user_preferences_accent_color_check
      CHECK (accent_color IN ('blue','green','purple','amber','teal'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name='user_preferences' AND constraint_name='user_preferences_theme_preset_check'
  ) THEN
    ALTER TABLE user_preferences
      ADD CONSTRAINT user_preferences_theme_preset_check
      CHECK (theme_preset IN ('midnight','ocean','forest','slate'));
  END IF;
END $$;
