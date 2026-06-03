-- 070_mfa_trusted_devices.sql
-- Status: apply to Supabase project qtiscbvhlvdvafwtdtcd.
--
-- "Trust this device for 24 hours" for staff TOTP MFA. After a successful
-- authenticator code, the device gets a random token (stored here as a SHA-256
-- hash, in an httpOnly cookie on the browser) valid for 24h. On the next login
-- the portal checks for a live token for that user and skips the TOTP prompt.
-- Service-role only (RLS on, no client policies).

CREATE TABLE IF NOT EXISTS public.mfa_trusted_devices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,            -- sha256 of the cookie token
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  CONSTRAINT mfa_trusted_devices_token_uniq UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_mfa_trusted_devices_user
  ON public.mfa_trusted_devices (user_id, expires_at);

ALTER TABLE public.mfa_trusted_devices ENABLE ROW LEVEL SECURITY;
-- No policies: only the service-role API routes read/write this.
