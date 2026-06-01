-- ═══════════════════════════════════════════════════════════════════
-- 048_b2b_email_templates.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd, then kept for reference.
--
-- Editable transactional email templates for the B2B order flow. Override-only:
-- defaults live in code (lib/email-templates.ts); a row here stores an admin's
-- override + enabled flag. Deleting a row resets that template to default.
-- Also adds an idempotency guard so the Stripe webhook sends the on-paid
-- distributor emails (confirmation + invoice) exactly once.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.b2b_email_templates (
  key        TEXT PRIMARY KEY,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  subject    TEXT,
  body       TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID
);

ALTER TABLE public.b2b_orders
  ADD COLUMN IF NOT EXISTS distributor_notified_at TIMESTAMPTZ;
