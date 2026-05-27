-- ═══════════════════════════════════════════════════════════════════
-- 036_workshop_document_branding.sql
-- Letterhead + footer for printed/emailed workshop documents (quotes,
-- invoices, job cards). Lives on the workshop_settings singleton.
-- business_name seeds to the workshop trading name; the rest stay blank
-- until an admin fills them in (rendered fields are omitted when blank).
-- Service-role-only (RLS already on workshop_settings).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.workshop_settings
  ADD COLUMN IF NOT EXISTS business_name    TEXT,
  ADD COLUMN IF NOT EXISTS business_abn     TEXT,
  ADD COLUMN IF NOT EXISTS business_address TEXT,
  ADD COLUMN IF NOT EXISTS business_phone   TEXT,
  ADD COLUMN IF NOT EXISTS business_email   TEXT,
  ADD COLUMN IF NOT EXISTS document_footer  TEXT;

UPDATE public.workshop_settings
   SET business_name = COALESCE(business_name, 'Vehicle Performance Solutions')
 WHERE id = 'singleton';
