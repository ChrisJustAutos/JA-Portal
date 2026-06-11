-- 102_integration_settings.sql
-- Self-service integration credentials (Settings → Connections → Integrations).
-- A key/value store the comms libs read FIRST, falling back to Vercel env —
-- so an admin can paste ClickSend / Resend / intake-token credentials in the
-- portal and connect without touching Vercel. Service-role only (RLS on, no
-- policies); secrets never reach the client unmasked.

CREATE TABLE IF NOT EXISTS public.integration_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.integration_settings ENABLE ROW LEVEL SECURITY;
