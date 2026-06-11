-- 100_crm_round_robin.sql
-- Round-robin owner assignment for website leads (replaces the ActiveCampaign/
-- Zapier round-robin): crm_settings carries the rotation roster (user ids, in
-- rotation order) and a pointer to the next assignee. /api/crm/intake assigns
-- each new website lead to the next person and advances the pointer.

ALTER TABLE public.crm_settings
  ADD COLUMN IF NOT EXISTS round_robin_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS round_robin_pointer  INT   NOT NULL DEFAULT 0;
