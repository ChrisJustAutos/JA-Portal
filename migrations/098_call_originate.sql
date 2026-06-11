-- ═══════════════════════════════════════════════════════════════════
-- 098_call_originate.sql
-- Click-to-dial from the CRM. Extends call_monitor_events (the proven
-- pending→claimed→connected/failed/expired queue the on-PBX ja-ami-monitor
-- agent drains over Supabase Realtime) with an 'originate' mode: the agent
-- AMI-Originates the actor's extension first, then dials the customer and
-- bridges, acking the call's Linkedid into result_linkedid.
--
-- ⚠ The portal UI is feature-flagged (NEXT_PUBLIC_CLICK_TO_DIAL) and inserts
-- no originate rows until the PBX worker is updated to handle the new mode —
-- this migration is safe to apply ahead of the worker deploy.
--
-- calls.crm_logged_at: linkage cron marker — recent calls (inbound + the
-- originated ones, matched by linkedid) get logged onto the CRM contact
-- timeline exactly once.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.call_monitor_events
  DROP CONSTRAINT IF EXISTS call_monitor_events_mode_check;
ALTER TABLE public.call_monitor_events
  ADD CONSTRAINT call_monitor_events_mode_check
  CHECK (mode IN ('listen','whisper','barge','originate'));

ALTER TABLE public.call_monitor_events
  ADD COLUMN IF NOT EXISTS dial_number     TEXT,   -- customer number (E.164)
  ADD COLUMN IF NOT EXISTS contact_id      UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lead_id         UUID REFERENCES public.crm_leads(id)    ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS result_linkedid TEXT,   -- Asterisk Linkedid the agent acks back
  ADD COLUMN IF NOT EXISTS call_id         UUID;   -- calls.id once the CDR linkage resolves

ALTER TABLE public.calls
  ADD COLUMN IF NOT EXISTS crm_logged_at TIMESTAMPTZ;
