-- ═══════════════════════════════════════════════════════════════════
-- 097_crm_pipeline_stages.sql
-- CRM overhaul Phase 1: editable pipeline stages + workshop-sync settings.
--
-- crm_pipeline_stages replaces the fixed LEAD_STAGES enum in lib/crm.ts.
-- `key` is an immutable slug — crm_leads.stage (free TEXT) keeps storing it,
-- so renames touch only `label` and nothing migrates. Won/lost semantics move
-- from magic strings to is_won/is_lost flags. Stages are archived (never hard
-- deleted) and archival requires re-staging the leads that reference them.
--
-- crm_settings is the CRM's singleton config: how workshop quote status
-- changes map onto lead stage moves, and whether quote totals sync the lead
-- value (the workshop→CRM bridge, lib/crm-bridge.ts, reads this).
--
-- Service-role access only (RLS on, no policies) like the rest of crm_*.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.crm_pipeline_stages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT UNIQUE NOT NULL,
  label       TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#4f8ef7',
  sort_order  INT  NOT NULL DEFAULT 0,
  on_board    BOOLEAN NOT NULL DEFAULT true,   -- off-board stages (on_hold) stay reachable from the editor
  is_won      BOOLEAN NOT NULL DEFAULT false,
  is_lost     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

DROP TRIGGER IF EXISTS crm_pipeline_stages_updated ON public.crm_pipeline_stages;
CREATE TRIGGER crm_pipeline_stages_updated BEFORE UPDATE ON public.crm_pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION public.crm_set_updated_at();

-- Seed from the previously hard-coded pipeline (colors from the old STAGE_COLOR map).
INSERT INTO public.crm_pipeline_stages (key, label, color, sort_order, on_board, is_won, is_lost) VALUES
  ('new',       'New',       '#4f8ef7', 1, true,  false, false),
  ('contacted', 'Contacted', '#2dd4bf', 2, true,  false, false),
  ('quoted',    'Quoted',    '#a78bfa', 3, true,  false, false),
  ('follow_up', 'Follow-up', '#fbbf24', 4, true,  false, false),
  ('won',       'Won',       '#34c77b', 5, true,  true,  false),
  ('lost',      'Lost',      '#f04e4e', 6, true,  false, true),
  ('on_hold',   'On hold',   '#8b90a0', 7, false, false, false)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.crm_settings (
  id              TEXT PRIMARY KEY DEFAULT 'singleton',
  -- workshop quote status → lead stage key; empty/missing value = don't move
  quote_stage_map JSONB NOT NULL DEFAULT
    '{"sent":"quoted","accepted":"won","declined":"lost","converted":"won"}'::jsonb,
  sync_lead_value BOOLEAN NOT NULL DEFAULT true,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.crm_settings (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.crm_pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_settings        ENABLE ROW LEVEL SECURITY;
