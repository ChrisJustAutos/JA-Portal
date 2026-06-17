-- 128_user_reply_to_email.sql
-- Per-staff Reply-To address. When a staff member sends an outbound email
-- (quote / purchase order / tax invoice / CRM email), the Reply-To header is
-- set to their configured address so customer replies land in the right shared
-- inbox — e.g. Morgan's documents reply to orders@justautosmechanical.com.au.
-- Set per user in Settings → Users & Staff. Falls back to the document's
-- business email / RESEND_REPLY_TO when blank.
alter table public.user_profiles
  add column if not exists reply_to_email text;
