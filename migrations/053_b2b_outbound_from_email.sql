-- ═══════════════════════════════════════════════════════════════════
-- 053_b2b_outbound_from_email.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd, then kept for reference.
--
-- Configurable "from" mailbox for all B2B outbound notification emails
-- (admin order, distributor confirmation/invoice/shipped, supplier drop-ship PO).
-- Resolved by lib/b2b-settings.getFromMailbox(); falls back to env/default if blank.
-- Must be a mailbox in the Graph app's M365 tenant with Mail.Send consented.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.b2b_settings
  ADD COLUMN IF NOT EXISTS outbound_from_email TEXT;
