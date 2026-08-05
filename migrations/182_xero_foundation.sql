-- 182: Xero migration foundation. Mirrors myob_connections: one row per
-- entity label (VPS/JAWS), each mapped to a Xero organisation (tenant).
-- MYOB stays connected read-only for history after cutover.
CREATE TABLE IF NOT EXISTS public.xero_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL UNIQUE,
  tenant_id text,
  tenant_name text,
  access_token text,
  refresh_token text,
  access_expires_at timestamptz,
  scopes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
ALTER TABLE public.xero_connections ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.xero_api_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_label text,
  method text,
  path text,
  status int,
  duration_ms int,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.xero_api_log ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS xero_api_log_created_idx ON public.xero_api_log (created_at desc);
