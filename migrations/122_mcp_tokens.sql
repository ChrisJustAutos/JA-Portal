-- 122: Per-user personal access tokens for the JA Portal MCP connector.
-- Each staff member mints a token in Settings → Claude connector and adds it to
-- their Claude (Desktop / Code) as a Bearer header. The MCP server resolves the
-- token → user and runs every tool call as that user, so portal roles/permissions
-- (and per-advisor call scoping) apply. We store only a SHA-256 hash of the token.

CREATE TABLE IF NOT EXISTS public.mcp_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL,
  label        TEXT,
  token_prefix TEXT NOT NULL,                 -- first chars, for display only
  token_hash   TEXT NOT NULL,                 -- sha256(full token), hex
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS mcp_tokens_hash_idx ON public.mcp_tokens (token_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS mcp_tokens_user_idx ON public.mcp_tokens (user_id);
ALTER TABLE public.mcp_tokens ENABLE ROW LEVEL SECURITY;
