-- ═══════════════════════════════════════════════════════════════════
-- 116_task_automations.sql
-- Tasks module Phase 2 — the Monday-style visual automation builder.
--
-- An automation is a GRAPH (React Flow native shape:
-- {nodes:[{id,type,position,data}], edges:[{id,source,target,sourceHandle}]}).
-- Node kinds: trigger / action / condition (yes|no handles) / wait. Waits are
-- relative to when the node is reached. The */5 cron claims due enrolments
-- atomically and walks the graph until a wait / retry backoff / the end.
--
-- Triggers: task_created / status_changed / assignee_changed fire inline from
-- the task API; due_soon / overdue are found by an hourly cron scan; webhook
-- via a tokened endpoint. Mirrors the proven CRM automation engine
-- (migration 099) but scoped entirely to tasks — no CRM linkage.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.task_automations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  description    TEXT,
  trigger_event  TEXT NOT NULL DEFAULT 'task_created',
  trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  graph          JSONB,
  graph_version  INT NOT NULL DEFAULT 1,
  enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  webhook_token  TEXT UNIQUE,
  webhook_secret TEXT,
  created_by     UUID REFERENCES public.user_profiles(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at     TIMESTAMPTZ
);
ALTER TABLE public.task_automations ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.task_automation_enrolments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id   UUID NOT NULL REFERENCES public.task_automations(id) ON DELETE CASCADE,
  task_id         UUID REFERENCES public.tasks(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'active',   -- active | done | cancelled
  current_node_id TEXT,
  node_entered_at TIMESTAMPTZ,
  graph_version   INT,
  attempt_count   INT NOT NULL DEFAULT 0,
  next_run_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  context         JSONB,
  dedupe_key      TEXT,
  cancel_reason   TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run_at     TIMESTAMPTZ
);
ALTER TABLE public.task_automation_enrolments ENABLE ROW LEVEL SECURITY;

-- One ACTIVE run per (automation, task); dedupe key blocks duplicate
-- cron-detected enrolments (due_soon/overdue re-fire only after change).
CREATE UNIQUE INDEX IF NOT EXISTS task_auto_enrol_active_idx
  ON public.task_automation_enrolments (automation_id, task_id)
  WHERE status = 'active' AND task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS task_auto_enrol_dedupe_idx
  ON public.task_automation_enrolments (automation_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_auto_enrol_due_idx
  ON public.task_automation_enrolments (next_run_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.task_automation_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id  UUID NOT NULL REFERENCES public.task_automation_enrolments(id) ON DELETE CASCADE,
  node_id       TEXT,
  action        TEXT,
  status        TEXT,        -- sent | skipped | failed
  detail        TEXT,
  attempt       INT NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.task_automation_runs ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS task_auto_runs_enrol_idx ON public.task_automation_runs (enrolment_id);

CREATE TABLE IF NOT EXISTS public.task_automation_checkpoints (
  key        TEXT PRIMARY KEY,
  value      JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.task_automation_checkpoints ENABLE ROW LEVEL SECURITY;
