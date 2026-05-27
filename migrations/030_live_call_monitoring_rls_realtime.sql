-- ═══════════════════════════════════════════════════════════════════
-- 030_live_call_monitoring_rls_realtime.sql
-- Harden + finalise live call monitoring now the on-PBX AMI monitor
-- (ja-ami-monitor.service) is live and writes directly to Supabase.
--
-- Architecture (Option B — Supabase as the bus, no inbound on the PBX):
--   • The agent writes the active-channel snapshot straight into
--     live_call_snapshot (id='freepbx-1') using the SERVICE-ROLE key.
--   • For ChanSpy, the portal enqueues a row into call_monitor_events
--     (/api/calls/live/spy). The agent SUBSCRIBES to that table via Realtime
--     (service-role), claims the pending row, runs ChanSpy, and writes the
--     outcome back (status connected|failed, completed_at).
--
-- PREREQUISITE: the agent MUST use the service-role key for both the snapshot
-- upsert and the Realtime subscription. service_role bypasses RLS, so the
-- locks below do not affect it. Using the anon key after this migration would
-- break the agent.
--
-- 1. Lock both tables to service-role-only (RLS on, no policy). They hold live
--    caller numbers/names and the who-monitored-whom audit trail; the public
--    anon key must not be able to read them via PostgREST. The portal API
--    routes already use the service-role key.
-- 2. Put call_monitor_events in the Realtime publication so the agent's
--    service-role subscription receives new spy requests.
-- 3. Default the snapshot id to 'freepbx-1' (the only PBX today) for clarity —
--    the agent upserts the id explicitly, so this is cosmetic.
-- ═══════════════════════════════════════════════════════════════════

-- 1. Snapshot id default (cosmetic; agent upserts id explicitly).
ALTER TABLE public.live_call_snapshot ALTER COLUMN id SET DEFAULT 'freepbx-1';

-- 2. RLS: service-role-only. Enabling RLS with no policy denies anon +
--    authenticated; service_role and the table owner bypass RLS, so the agent
--    and the portal's service-role API routes are unaffected.
ALTER TABLE public.live_call_snapshot  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_monitor_events ENABLE ROW LEVEL SECURITY;

-- 3. Realtime: the agent subscribes to INSERTs on the spy queue. REPLICA
--    IDENTITY FULL so update payloads carry the full row if the agent ever
--    watches status transitions too. Both statements are idempotent.
ALTER TABLE public.call_monitor_events REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'call_monitor_events'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.call_monitor_events;
    END IF;
  END IF;
END $$;
