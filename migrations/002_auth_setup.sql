-- ═══════════════════════════════════════════════════════════════════
-- JA Portal — Auth + Role-Based Access Control
-- Status: ALREADY APPLIED to Supabase project qtiscbvhlvdvafwtdtcd
-- This file is saved for reference / disaster recovery only.
-- ═══════════════════════════════════════════════════════════════════

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'manager', 'sales', 'accountant', 'viewer');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  role user_role NOT NULL DEFAULT 'viewer',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_sign_in_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id),
  UNIQUE (email)
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_role ON user_profiles(role);
CREATE INDEX IF NOT EXISTS idx_user_profiles_active ON user_profiles(is_active) WHERE is_active = TRUE;

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_profiles_updated ON user_profiles;
CREATE TRIGGER trg_user_profiles_updated
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE FUNCTION is_admin(uid UUID)
RETURNS BOOLEAN AS $$
  SELECT COALESCE((SELECT role = 'admin' AND is_active FROM user_profiles WHERE id = uid), FALSE);
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

CREATE TABLE IF NOT EXISTS auth_audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id UUID,
  actor_email TEXT,
  action TEXT NOT NULL,
  target_user_id UUID,
  target_email TEXT,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON auth_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON auth_audit_log(actor_id);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_read_own_profile" ON user_profiles;
CREATE POLICY "users_read_own_profile" ON user_profiles
  FOR SELECT USING (auth.uid() = id OR is_admin(auth.uid()));
DROP POLICY IF EXISTS "admins_write_profiles" ON user_profiles;
CREATE POLICY "admins_write_profiles" ON user_profiles
  FOR ALL USING (is_admin(auth.uid()));

ALTER TABLE auth_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins_read_audit" ON auth_audit_log;
CREATE POLICY "admins_read_audit" ON auth_audit_log FOR SELECT USING (is_admin(auth.uid()));

CREATE OR REPLACE FUNCTION has_any_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS(SELECT 1 FROM user_profiles WHERE role = 'admin' AND is_active = TRUE);
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION has_any_admin() TO anon;
GRANT EXECUTE ON FUNCTION has_any_admin() TO authenticated;
