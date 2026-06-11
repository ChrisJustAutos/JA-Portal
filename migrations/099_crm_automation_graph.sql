-- ═══════════════════════════════════════════════════════════════════
-- 099_crm_automation_graph.sql
-- CRM overhaul Phase 3 — the Make-style flow builder.
--
-- Automations become a GRAPH (one JSONB column, React Flow native shape:
-- {nodes:[{id,type,position,data}], edges:[{id,source,target,sourceHandle}]})
-- instead of a linear step list. Node kinds: trigger / action / condition
-- (yes|no handles) / wait. Waits are RELATIVE (delta from when the node is
-- reached), replacing the old cumulative-from-enrolment delays.
--
-- Enrolments get a graph cursor (current_node_id + node_entered_at) and
-- retry bookkeeping. The old (automation_id, lead_id) hard-unique becomes
-- "one ACTIVE per pair" partial uniques so re-enrolment after completion is
-- possible, plus a contact-only variant for contact-level triggers (P4).
--
-- The engine LAZILY migrates legacy linear automations: graph IS NULL →
-- linearStepsToGraph(steps) is persisted on first touch and in-flight
-- enrolments map next_step_order → 'step-N' keeping next_run_at untouched.
-- Legacy columns stay for rollback.
--
-- crm_automation_checkpoints: cron-detected trigger watermarks (P4:
-- no-activity scans, quote-status safety polls).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.crm_automations
  ADD COLUMN IF NOT EXISTS graph          JSONB,
  ADD COLUMN IF NOT EXISTS graph_version  INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS webhook_token  TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS webhook_secret TEXT;

ALTER TABLE public.crm_automation_enrolments
  ADD COLUMN IF NOT EXISTS current_node_id TEXT,
  ADD COLUMN IF NOT EXISTS node_entered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS graph_version   INT,
  ADD COLUMN IF NOT EXISTS attempt_count   INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS context         JSONB,
  ADD COLUMN IF NOT EXISTS dedupe_key      TEXT;

-- Re-enrolment: one ACTIVE run per (automation, lead) — done/cancelled rows
-- no longer block a fresh enrolment. Contact-only enrolments (lead NULL) get
-- their own active-unique for P4's contact-level triggers.
DROP INDEX IF EXISTS crm_auto_enrol_unique;
CREATE UNIQUE INDEX IF NOT EXISTS crm_auto_enrol_active_lead_idx
  ON public.crm_automation_enrolments (automation_id, lead_id)
  WHERE status = 'active' AND lead_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS crm_auto_enrol_active_contact_idx
  ON public.crm_automation_enrolments (automation_id, contact_id)
  WHERE status = 'active' AND lead_id IS NULL AND contact_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS crm_auto_enrol_dedupe_idx
  ON public.crm_automation_enrolments (automation_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

ALTER TABLE public.crm_automation_runs
  ADD COLUMN IF NOT EXISTS node_id TEXT,
  ADD COLUMN IF NOT EXISTS attempt INT NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS public.crm_automation_checkpoints (
  key        TEXT PRIMARY KEY,
  value      JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.crm_automation_checkpoints ENABLE ROW LEVEL SECURITY;
