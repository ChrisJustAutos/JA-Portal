-- ═══════════════════════════════════════════════════════════════════
-- 065_notifications.sql
-- Status: apply to Supabase project qtiscbvhlvdvafwtdtcd, then this file
-- is kept here for reference / disaster recovery.
--
-- Cross-module notifications:
--   1. notifications table — one row per (recipient, event). Red badges on
--      app tiles / sidebar count unread rows per module; the bell dropdown
--      lists them. All writes go through service-role API routes (or the
--      trigger below); clients are SELECT-only on their own rows.
--   2. dedupe_key — events emitted from crons/webhooks that may re-fire
--      (Stripe retries, Monday sweeps) carry a stable key so the same event
--      never notifies the same user twice. Rows without an explicit key get
--      a random one (the unique constraint then never blocks them).
--   3. Missed-call trigger — the FreePBX ja-cdr-sync agent writes calls rows
--      directly to the DB (no portal code path), so missed-call
--      notifications are emitted by a DB trigger.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  module     TEXT NOT NULL,           -- matches DEFAULT_NAV ids: b2b, calls, diary, workshop-tasks, …
  title      TEXT NOT NULL,
  body       TEXT,
  href       TEXT,                    -- where clicking the notification navigates
  dedupe_key TEXT NOT NULL DEFAULT (gen_random_uuid()::text),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at    TIMESTAMPTZ,
  CONSTRAINT notifications_user_dedupe UNIQUE (user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON public.notifications (user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON public.notifications (user_id, created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notifications_select ON public.notifications;
CREATE POLICY notifications_select ON public.notifications
  FOR SELECT TO authenticated USING (user_id = auth.uid());
-- No INSERT/UPDATE/DELETE policies: writes are service-role only.

-- ── Missed inbound call → notify admin/manager/sales ─────────────────
-- Guards: inbound only, not answered, recent (so a CDR backfill can't flood),
-- and deduped per linkedid (queue attempts share a linkedid across legs).
CREATE OR REPLACE FUNCTION public.notify_missed_call()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.direction = 'inbound'
     AND COALESCE(NEW.disposition, '') <> 'ANSWERED'
     AND NEW.call_date > now() - INTERVAL '2 hours' THEN
    INSERT INTO notifications (user_id, module, title, body, href, dedupe_key)
    SELECT up.id, 'calls', 'Missed call',
           COALESCE(NULLIF(NEW.caller_name, ''), NULLIF(NEW.external_number, ''), 'Unknown caller'),
           '/calls',
           'call:' || COALESCE(NULLIF(NEW.linkedid, ''), NEW.id::text)
    FROM user_profiles up
    WHERE up.role::text IN ('admin', 'manager', 'sales') AND up.is_active
    ON CONFLICT (user_id, dedupe_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_notify_missed_call ON public.calls;
CREATE TRIGGER trg_notify_missed_call
  AFTER INSERT ON public.calls
  FOR EACH ROW EXECUTE FUNCTION public.notify_missed_call();
