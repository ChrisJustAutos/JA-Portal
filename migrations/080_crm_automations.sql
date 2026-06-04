-- ═══════════════════════════════════════════════════════════════════
-- 080_crm_automations.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd ("Just Autos Portal").
--
-- CRM Phase 2 — automations. Time-based follow-up sequences (e.g. 3 days →
-- email, 7 days → SMS, 10 days → task) triggered when a lead is created or
-- moves to a stage. Driven by the /api/cron/crm-automations sweep.
--
--   crm_automations           — a sequence definition + its trigger
--   crm_automation_steps       — ordered steps; delay is hours from enrolment
--   crm_automation_enrolments  — a lead's run through an automation
--   crm_automation_runs        — per-step audit (also guards against re-sends)
--
-- Also adds crm_contacts.do_not_contact so the engine can hard-stop outreach.
-- RLS enabled, service-role only (engine + API routes use the service key).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.crm_contacts ADD COLUMN IF NOT EXISTS do_not_contact BOOLEAN NOT NULL DEFAULT false;

-- ── Automation definitions ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_automations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  description     TEXT,
  trigger_event   TEXT NOT NULL DEFAULT 'lead_created',  -- 'lead_created' | 'stage_changed'
  trigger_stage   TEXT,                                  -- stage filter (which stage)
  enabled         BOOLEAN NOT NULL DEFAULT false,
  cancel_on_stages TEXT[] NOT NULL DEFAULT '{won,lost}', -- stop the sequence if the lead reaches one of these
  created_by      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

-- ── Steps ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_automation_steps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES public.crm_automations(id) ON DELETE CASCADE,
  step_order    INT NOT NULL DEFAULT 1,
  delay_hours   INT NOT NULL DEFAULT 0,        -- hours from enrolment start (cumulative)
  action        TEXT NOT NULL,                 -- 'email' | 'sms' | 'task' | 'notify_owner'
  subject       TEXT,                          -- email subject / task title / notification title
  body          TEXT,                          -- email body / sms text / task description (templated)
  task_priority TEXT DEFAULT 'normal',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS crm_automation_steps_auto_idx ON public.crm_automation_steps (automation_id, step_order);

-- ── Enrolments ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_automation_enrolments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id   UUID NOT NULL REFERENCES public.crm_automations(id) ON DELETE CASCADE,
  lead_id         UUID REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  contact_id      UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'done' | 'cancelled'
  next_step_order INT NOT NULL DEFAULT 1,
  next_run_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run_at     TIMESTAMPTZ,
  cancel_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One live enrolment per (automation, lead).
CREATE UNIQUE INDEX IF NOT EXISTS crm_auto_enrol_unique ON public.crm_automation_enrolments (automation_id, lead_id);
CREATE INDEX IF NOT EXISTS crm_auto_enrol_due_idx ON public.crm_automation_enrolments (next_run_at) WHERE status = 'active';

-- ── Per-step run log ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_automation_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id  UUID NOT NULL REFERENCES public.crm_automation_enrolments(id) ON DELETE CASCADE,
  step_id       UUID REFERENCES public.crm_automation_steps(id) ON DELETE SET NULL,
  action        TEXT,
  status        TEXT,                          -- 'sent' | 'skipped' | 'failed'
  detail        TEXT,
  ran_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS crm_automation_runs_enrol_idx ON public.crm_automation_runs (enrolment_id);

-- ── updated_at trigger (reuse Phase-1 function) ──────────────────────
DROP TRIGGER IF EXISTS crm_automations_set_updated ON public.crm_automations;
CREATE TRIGGER crm_automations_set_updated BEFORE UPDATE ON public.crm_automations
  FOR EACH ROW EXECUTE FUNCTION public.crm_set_updated_at();

-- ── RLS: service-role only ────────────────────────────────────────────
ALTER TABLE public.crm_automations            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_automation_steps       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_automation_enrolments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_automation_runs        ENABLE ROW LEVEL SECURITY;

-- ── Seed one DISABLED example so the UI isn't empty and the shape is clear ──
DO $$
DECLARE aid UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.crm_automations) THEN
    INSERT INTO public.crm_automations (name, description, trigger_event, trigger_stage, enabled, cancel_on_stages)
    VALUES ('Quote follow-up', 'Chase a quote that hasn''t been won yet: email at 3 days, SMS at 7 days, then a call task at 10 days. Stops automatically if the lead is won or lost.', 'stage_changed', 'quoted', false, '{won,lost}')
    RETURNING id INTO aid;
    INSERT INTO public.crm_automation_steps (automation_id, step_order, delay_hours, action, subject, body) VALUES
      (aid, 1, 72,  'email', 'Following up on your quote',
       'Hi {{first_name}},' || chr(10) || chr(10) || 'Just following up on the quote we sent through for {{vehicle}}. Did you have any questions, or would you like to go ahead and get it booked in?' || chr(10) || chr(10) || 'Happy to help with anything.' || chr(10) || chr(10) || 'Thanks,' || chr(10) || 'Just Autos'),
      (aid, 2, 168, 'sms', NULL,
       'Hi {{first_name}}, just checking in on your Just Autos quote for {{vehicle}} - keen to help if you''d like to proceed or have any questions. Reply anytime.'),
      (aid, 3, 240, 'task', 'Call {{contact_name}} about their quote',
       'Automated follow-up: phone {{contact_name}} re the {{vehicle}} quote ({{value}}). No response to email or SMS yet.');
  END IF;
END $$;
