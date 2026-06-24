-- ═══════════════════════════════════════════════════════════════════
-- 139_letter_logo_printers.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd.
--
-- Make the letter automation fully portal-managed:
--   • logo_path — uploaded letterhead logo (in the workshop-letters bucket),
--     replaces the /public/letterhead-logo.png file
--   • print_agent_settings — printer routing the self-hosted label-print-agent
--     reads from the DB (so the portal drives it, falling back to env). The
--     agent also publishes the printers installed on its PC + a heartbeat so the
--     portal can offer a dropdown instead of a free-text printer name.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.workshop_letter_automation ADD COLUMN IF NOT EXISTS logo_path TEXT;

CREATE TABLE IF NOT EXISTS public.print_agent_settings (
  id                 TEXT PRIMARY KEY DEFAULT 'singleton',
  label_printer      TEXT,
  invoice_printer    TEXT,
  letter_printer     TEXT,
  envelope_printer   TEXT,
  letter_scale       TEXT DEFAULT 'fit',
  envelope_scale     TEXT DEFAULT 'noscale',
  available_printers JSONB NOT NULL DEFAULT '[]'::jsonb,  -- written by the agent
  agent_host         TEXT,
  agent_last_seen    TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.print_agent_settings (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.print_agent_settings ENABLE ROW LEVEL SECURITY;  -- service-role only (agent + portal)
