-- ═══════════════════════════════════════════════════════════════════
-- 028_call_monitoring.sql
-- Live call monitoring (listen / whisper / barge) for management.
--
-- 1. user_profiles.phone_extension — the SIP extension the portal should
--    ring for this user when they start a monitor session. The PBX-side
--    service rings this extension (if currently registered) and bridges it
--    to the target call via Asterisk ChanSpy.
--
-- 2. call_monitor_events — audit trail. Every listen/whisper/barge attempt
--    is logged (who monitored whom, in what mode, and the outcome) for
--    compliance. Restricted to the monitor:calls permission server-side.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS phone_extension TEXT;

CREATE TABLE IF NOT EXISTS public.call_monitor_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  actor_extension    TEXT,                       -- the manager's ext we rang
  mode               TEXT NOT NULL CHECK (mode IN ('listen','whisper','barge')),
  target_call_linkedid TEXT,                      -- live call's linkedid (if known)
  target_channel     TEXT,                        -- Asterisk channel spied on
  target_agent_ext   TEXT,                        -- ext currently on the target call
  status             TEXT NOT NULL DEFAULT 'requested'  -- requested | connected | failed
                       CHECK (status IN ('requested','connected','failed')),
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_monitor_events_actor_idx
  ON public.call_monitor_events (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS call_monitor_events_created_idx
  ON public.call_monitor_events (created_at DESC);
