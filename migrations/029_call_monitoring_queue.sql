-- ═══════════════════════════════════════════════════════════════════
-- 029_call_monitoring_queue.sql
-- Pivot live call monitoring to a command-queue so it reuses the existing
-- on-PBX agent's OUTBOUND X-Service-Token channel — nothing new is exposed
-- on the FreePBX box.
--
-- 1. live_call_snapshot — the agent pushes the current active-call list
--    (every ~2s) into a single row; the managers' board reads it.
--
-- 2. call_monitor_events (from migration 028) becomes the spy-request queue
--    as well as the audit trail:
--      portal enqueues  → status 'pending'
--      agent claims     → 'claimed'  (claimed_at)
--      agent acks       → 'connected' | 'failed'  (completed_at)
--      never claimed    → 'expired'   (swept by the agent poll)
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.live_call_snapshot (
  id          TEXT PRIMARY KEY DEFAULT 'pbx',
  calls       JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.call_monitor_events
  ADD COLUMN IF NOT EXISTS claimed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE public.call_monitor_events
  ALTER COLUMN status SET DEFAULT 'pending';

ALTER TABLE public.call_monitor_events
  DROP CONSTRAINT IF EXISTS call_monitor_events_status_check;
ALTER TABLE public.call_monitor_events
  ADD CONSTRAINT call_monitor_events_status_check
  CHECK (status IN ('pending','claimed','connected','failed','expired'));

-- Fast lookup of the queue the agent drains.
CREATE INDEX IF NOT EXISTS call_monitor_events_pending_idx
  ON public.call_monitor_events (created_at) WHERE status = 'pending';
