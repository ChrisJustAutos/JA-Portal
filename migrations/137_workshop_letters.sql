-- ═══════════════════════════════════════════════════════════════════
-- 137_workshop_letters.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd.
--
-- Workshop Thank-You Letter automation. Replaces the old Zoho (MYOB→Monday)
-- + Zapier (Monday→filter>$5000→Google Docs letter→Drive→Epson print) chain
-- with one portal-hosted automation:
--
--   finalised job invoice pushed to MYOB (VPS) with total > threshold
--     → render thank-you letter (A4) + DL envelope
--     → enqueue both to label_print_jobs → label-print-agent prints them.
--
-- Booking deposits never flow through the finalise step (they live in
-- workshop_payments), so "finalised jobs only, no deposits" is free.
-- ═══════════════════════════════════════════════════════════════════

-- ── Reusable letter templates ({{placeholder}} bodies) ──────────────
CREATE TABLE IF NOT EXISTS public.workshop_letter_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  category      TEXT,                          -- thank_you | rego_due | service_due | custom
  body          TEXT NOT NULL,                 -- supports {{first_name}}, {{vehicle}}, etc.
  sign_off_name TEXT,                          -- e.g. "Matt Smith"
  sign_off_title TEXT,                         -- e.g. "Owner/Director"
  enabled       BOOLEAN NOT NULL DEFAULT true,
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Single-row automation config + letterhead (brand identity) ──────
-- Letterhead is the "Just Autos" brand on the printed letter — deliberately
-- distinct from the VPS company-file name in workshop_settings.
CREATE TABLE IF NOT EXISTS public.workshop_letter_automation (
  id                 TEXT PRIMARY KEY DEFAULT 'singleton',
  enabled            BOOLEAN NOT NULL DEFAULT false,  -- flip on from Settings once the printer + logo are set
  min_total          NUMERIC(12,2) NOT NULL DEFAULT 5000,  -- inc-GST invoice total
  template_id        UUID REFERENCES public.workshop_letter_templates(id) ON DELETE SET NULL,
  print_envelope     BOOLEAN NOT NULL DEFAULT true,
  letterhead_name    TEXT NOT NULL DEFAULT 'Just Autos',
  letterhead_abn     TEXT DEFAULT '31 645 834 813',
  letterhead_address TEXT DEFAULT '2/11 Windsor Road, Burnside, QLD 4560',
  letterhead_phone   TEXT DEFAULT '(07) 5476 0066',
  letterhead_email   TEXT DEFAULT 'sales@justautosmechanical.com.au',
  letterhead_website TEXT DEFAULT 'www.justautos.au',
  return_address     TEXT DEFAULT E'Just Autos\n2/11 Windsor Road\nBurnside QLD 4560',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.workshop_letter_automation (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING;

-- ── Audit / history of every letter (auto or manual) ────────────────
CREATE TABLE IF NOT EXISTS public.workshop_letter_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id            UUID REFERENCES public.workshop_bookings(id) ON DELETE SET NULL,
  customer_id           UUID REFERENCES public.workshop_customers(id) ON DELETE SET NULL,
  template_id           UUID REFERENCES public.workshop_letter_templates(id) ON DELETE SET NULL,
  trigger               TEXT NOT NULL DEFAULT 'auto',     -- auto | manual
  recipient_name        TEXT,
  recipient_address     TEXT,
  invoice_total         NUMERIC(12,2),
  myob_invoice_uid      TEXT,
  letter_storage_path   TEXT,
  envelope_storage_path TEXT,
  status                TEXT NOT NULL DEFAULT 'queued',    -- queued | printed | failed | skipped
  error                 TEXT,
  created_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workshop_letter_jobs_created_idx ON public.workshop_letter_jobs (created_at DESC);
-- One auto letter per booking — makes the finalise hook idempotent across retries / re-finalise.
CREATE UNIQUE INDEX IF NOT EXISTS workshop_letter_jobs_booking_auto_uidx
  ON public.workshop_letter_jobs (booking_id) WHERE trigger = 'auto';

-- Service-role only (portal APIs use service role; deny anon/authenticated).
ALTER TABLE public.workshop_letter_templates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_letter_automation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_letter_jobs       ENABLE ROW LEVEL SECURITY;

-- ── Extend the existing print queue ─────────────────────────────────
-- Allow letter/envelope kinds and let a job name its own storage bucket
-- (letters live in workshop-letters, not b2b-shipping-labels).
ALTER TABLE public.label_print_jobs DROP CONSTRAINT IF EXISTS label_print_jobs_kind_chk;
ALTER TABLE public.label_print_jobs ADD CONSTRAINT label_print_jobs_kind_chk
  CHECK (kind IN ('label','invoice','letter','envelope'));
ALTER TABLE public.label_print_jobs ADD COLUMN IF NOT EXISTS bucket TEXT;

-- ── Private storage bucket for letter/envelope PDFs ─────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('workshop-letters', 'workshop-letters', false)
ON CONFLICT (id) DO NOTHING;

-- ── Seed the thank-you template + point the automation at it ────────
INSERT INTO public.workshop_letter_templates (name, category, body, sign_off_name, sign_off_title, sort_order)
SELECT 'Thank you', 'thank_you',
  E'The team and I here at {{business_name}} wanted to reach out to say thank you very much for trusting us with your pride and joy. We understand the value and investment you have made in your vehicle and wanted to use this opportunity to show our gratitude.\n\nIn future if there is anything we can help you with please reach out as we will always be here to help.\n\nSafe travels and enjoy',
  'Matt Smith', 'Owner/Director', 0
WHERE NOT EXISTS (SELECT 1 FROM public.workshop_letter_templates WHERE category = 'thank_you');

UPDATE public.workshop_letter_automation
  SET template_id = (SELECT id FROM public.workshop_letter_templates WHERE category = 'thank_you' ORDER BY sort_order LIMIT 1)
  WHERE id = 'singleton' AND template_id IS NULL;
