-- ═══════════════════════════════════════════════════════════════════
-- 079_crm_core.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd ("Just Autos Portal").
--
-- CRM module — Phase 1. Replaces Monday (lead/quote pipeline + staff task
-- management) and lays the contact spine that Phase 2 (automations) and
-- Phase 3 (campaigns) build on. ActiveCampaign's contact storage maps to
-- crm_contacts / crm_companies.
--
-- Tables:
--   crm_companies   — optional org grouping for contacts
--   crm_contacts    — the customer record (deduped by email/phone), with a
--                     link to the portal-native workshop customer
--   crm_leads       — the deal / quote-flow card that moves through a pipeline
--                     (mirrors the Monday quote board stages)
--   crm_tasks       — assignable staff tasks (replaces Monday task management)
--   crm_activities  — the unified timeline (notes, calls, emails, sms, stage
--                     changes, website leads, workshop handoffs…)
--
-- All access is via service-role API routes under /api/crm, so RLS is enabled
-- with no policies (deny-all to anon/authenticated; service role bypasses it).
-- ═══════════════════════════════════════════════════════════════════

-- Keep updated_at fresh without each route having to remember.
CREATE OR REPLACE FUNCTION public.crm_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Companies ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_companies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  domain      TEXT,
  phone       TEXT,
  notes       TEXT,
  created_by  UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crm_companies_name_idx ON public.crm_companies (name);

-- ── Contacts ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name    TEXT,
  last_name     TEXT,
  name          TEXT NOT NULL,                 -- display name (always set)
  email         TEXT,
  phone         TEXT,
  mobile        TEXT,
  company_id    UUID REFERENCES public.crm_companies(id) ON DELETE SET NULL,
  company_name  TEXT,                          -- denormalised for quick display / unlinked orgs
  postcode      TEXT,
  source        TEXT,                          -- 'website' | 'manual' | 'call' | 'import' | …
  tags          TEXT[] NOT NULL DEFAULT '{}',
  owner_id      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  -- Link to the portal-native workshop customer (created/matched on handoff).
  workshop_customer_id UUID REFERENCES public.workshop_customers(id) ON DELETE SET NULL,
  notes         TEXT,
  last_activity_at TIMESTAMPTZ,
  created_by    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crm_contacts_email_idx  ON public.crm_contacts (lower(email));
CREATE INDEX IF NOT EXISTS crm_contacts_phone_idx  ON public.crm_contacts (phone);
CREATE INDEX IF NOT EXISTS crm_contacts_mobile_idx ON public.crm_contacts (mobile);
CREATE INDEX IF NOT EXISTS crm_contacts_owner_idx  ON public.crm_contacts (owner_id);
CREATE INDEX IF NOT EXISTS crm_contacts_name_idx   ON public.crm_contacts (name);
CREATE INDEX IF NOT EXISTS crm_contacts_workshop_idx ON public.crm_contacts (workshop_customer_id);

-- ── Leads (deal / quote-flow card) ───────────────────────────────────
-- Stage values (app-enforced, mirror the Monday quote board):
--   new | contacted | quoted | follow_up | won | lost | on_hold
CREATE TABLE IF NOT EXISTS public.crm_leads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id    UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  title         TEXT NOT NULL DEFAULT 'New lead',
  stage         TEXT NOT NULL DEFAULT 'new',
  value         NUMERIC(12,2),                 -- estimated value (inc GST)
  owner_id      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  source        TEXT,
  vehicle       TEXT,                          -- free-text rego / model for context
  details       TEXT,                          -- enquiry detail / quote notes
  contact_attempts INT NOT NULL DEFAULT 0,
  last_activity_at TIMESTAMPTZ,
  next_follow_up_at TIMESTAMPTZ,               -- drives Phase 2 follow-up automations
  workshop_quote_id UUID REFERENCES public.workshop_quotes(id) ON DELETE SET NULL,
  won_at        TIMESTAMPTZ,
  lost_at       TIMESTAMPTZ,
  lost_reason   TEXT,
  created_by    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crm_leads_stage_idx   ON public.crm_leads (stage);
CREATE INDEX IF NOT EXISTS crm_leads_owner_idx   ON public.crm_leads (owner_id);
CREATE INDEX IF NOT EXISTS crm_leads_contact_idx ON public.crm_leads (contact_id);
CREATE INDEX IF NOT EXISTS crm_leads_followup_idx ON public.crm_leads (next_follow_up_at) WHERE deleted_at IS NULL;

-- ── Tasks (staff task management) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | in_progress | done
  priority      TEXT NOT NULL DEFAULT 'normal', -- low | normal | high | urgent
  assignee_id   UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  due_at        TIMESTAMPTZ,
  contact_id    UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  lead_id       UUID REFERENCES public.crm_leads(id) ON DELETE SET NULL,
  completed_at  TIMESTAMPTZ,
  created_by    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crm_tasks_assignee_idx ON public.crm_tasks (assignee_id);
CREATE INDEX IF NOT EXISTS crm_tasks_status_idx   ON public.crm_tasks (status);
CREATE INDEX IF NOT EXISTS crm_tasks_due_idx      ON public.crm_tasks (due_at);
CREATE INDEX IF NOT EXISTS crm_tasks_lead_idx     ON public.crm_tasks (lead_id);
CREATE INDEX IF NOT EXISTS crm_tasks_contact_idx  ON public.crm_tasks (contact_id);

-- ── Activities (unified timeline) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_activities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id    UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  lead_id       UUID REFERENCES public.crm_leads(id) ON DELETE SET NULL,
  type          TEXT NOT NULL,                  -- note|call|email|sms|stage_change|lead_created|contact_created|task|workshop_handoff|website_lead
  body          TEXT,
  meta          JSONB,
  actor_id      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,  -- null = system / automation
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS crm_activities_contact_idx ON public.crm_activities (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crm_activities_lead_idx    ON public.crm_activities (lead_id, created_at DESC);

-- ── updated_at triggers ──────────────────────────────────────────────
DROP TRIGGER IF EXISTS crm_companies_set_updated ON public.crm_companies;
CREATE TRIGGER crm_companies_set_updated BEFORE UPDATE ON public.crm_companies
  FOR EACH ROW EXECUTE FUNCTION public.crm_set_updated_at();
DROP TRIGGER IF EXISTS crm_contacts_set_updated ON public.crm_contacts;
CREATE TRIGGER crm_contacts_set_updated BEFORE UPDATE ON public.crm_contacts
  FOR EACH ROW EXECUTE FUNCTION public.crm_set_updated_at();
DROP TRIGGER IF EXISTS crm_leads_set_updated ON public.crm_leads;
CREATE TRIGGER crm_leads_set_updated BEFORE UPDATE ON public.crm_leads
  FOR EACH ROW EXECUTE FUNCTION public.crm_set_updated_at();
DROP TRIGGER IF EXISTS crm_tasks_set_updated ON public.crm_tasks;
CREATE TRIGGER crm_tasks_set_updated BEFORE UPDATE ON public.crm_tasks
  FOR EACH ROW EXECUTE FUNCTION public.crm_set_updated_at();

-- ── RLS: deny-all to anon/authenticated; service role bypasses ───────
ALTER TABLE public.crm_companies  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_contacts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_leads      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_tasks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_activities ENABLE ROW LEVEL SECURITY;
