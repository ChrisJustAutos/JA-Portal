-- ═══════════════════════════════════════════════════════════════════
-- 058_b2b_email_logo.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd, then kept for reference.
--
-- Logo shown in the header of every B2B notification email. A public image URL
-- (uploaded via Settings to the b2b-catalogue bucket, or pasted). When blank the
-- emails fall back to the plain "Just Autos" text header.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.b2b_settings
  ADD COLUMN IF NOT EXISTS email_logo_url TEXT;
