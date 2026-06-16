-- 123: OAuth 2.1 (auth-code + PKCE) server for the Claude MCP connector.
-- Lets staff add the connector via Claude Desktop / claude.ai's GUI, which is
-- OAuth-only (Name + MCP URL + Client ID + Client Secret). Access tokens issued
-- by /token are stored in mcp_tokens (so /api/mcp resolves them unchanged).

CREATE TABLE IF NOT EXISTS public.oauth_clients (
  client_id          TEXT PRIMARY KEY,
  client_secret_hash TEXT,                       -- sha256 hex; null = public client
  name               TEXT,
  redirect_uris      TEXT[] NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.oauth_clients ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.oauth_codes (
  code                  TEXT PRIMARY KEY,         -- opaque random authorization code
  client_id             TEXT NOT NULL,
  user_id               UUID NOT NULL,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT,
  code_challenge_method TEXT,
  scope                 TEXT,
  expires_at            TIMESTAMPTZ NOT NULL,
  used                  BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.oauth_codes ENABLE ROW LEVEL SECURITY;

-- Seed the Claude connector client. Secret hash only (the plaintext secret is
-- handed to the admin out-of-band). Redirect URIs cover claude.ai web + Desktop.
INSERT INTO public.oauth_clients (client_id, client_secret_hash, name, redirect_uris)
VALUES (
  'ja-portal-claude',
  '5f05b95b7b83c470df4d0b2399e36358284a81f3c9259c7f07dae28c4c59a55a',
  'Claude (JA Portal connector)',
  ARRAY['https://claude.ai/api/mcp/auth_callback','https://claude.com/api/mcp/auth_callback']
)
ON CONFLICT (client_id) DO NOTHING;
