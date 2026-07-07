-- 154_missed_call_ring_group.sql
-- Status: applied to Supabase project qtiscbvhlvdvafwtdtcd 2026-07-07.
--
-- Ring-group pickups: ext A's ring logs its own NO-ANSWER calls row (own
-- linkedid — calls.linkedid is UNIQUE per row, so the migration-065 linkedid
-- dedupe never helped here) while ext B answers the same caller — A's insert
-- fired a "Missed call" bell notification even though the customer was
-- spoken to. Apply the same ±120s "rescued" rule the /calls UI + stats
-- already use (picked-up-elsewhere), at the notification source, in both
-- insert orders. Verified with a rolled-back live test: missed→answered
-- retracts, answered→missed suppresses, genuine misses still notify.

-- 1. Missed leg arrives AFTER the answered leg → don't notify at all.
CREATE OR REPLACE FUNCTION public.notify_missed_call()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.direction = 'inbound'
     AND COALESCE(NEW.disposition, '') <> 'ANSWERED'
     AND NEW.call_date > now() - INTERVAL '2 hours'
     -- Rescued? An answered inbound leg for the same caller within ±120s
     -- means this is just the un-answered leg of a ring-group pickup.
     AND (COALESCE(NEW.external_number, '') = '' OR NOT EXISTS (
       SELECT 1 FROM calls a
       WHERE a.direction = 'inbound'
         AND a.disposition = 'ANSWERED'
         AND a.external_number = NEW.external_number
         AND a.call_date BETWEEN NEW.call_date - INTERVAL '120 seconds'
                             AND NEW.call_date + INTERVAL '120 seconds'
     )) THEN
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

-- 2. Answered leg arrives (or a leg upgrades to ANSWERED) AFTER the missed
--    leg already notified → retract the still-unread notifications for the
--    sibling missed leg(s) of the same caller.
CREATE OR REPLACE FUNCTION public.rescue_missed_call_notifications()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.direction = 'inbound' AND NEW.disposition = 'ANSWERED' THEN
    -- The leg itself flipped missed → answered (upsert on linkedid).
    DELETE FROM notifications n
    WHERE n.module = 'calls' AND n.title = 'Missed call' AND n.read_at IS NULL
      AND n.dedupe_key = 'call:' || COALESCE(NULLIF(NEW.linkedid, ''), NEW.id::text);
    -- Sibling missed legs for the same caller within ±120s.
    IF COALESCE(NEW.external_number, '') <> '' THEN
      DELETE FROM notifications n
      USING calls c
      WHERE c.direction = 'inbound'
        AND COALESCE(c.disposition, '') <> 'ANSWERED'
        AND c.external_number = NEW.external_number
        AND c.call_date BETWEEN NEW.call_date - INTERVAL '120 seconds'
                            AND NEW.call_date + INTERVAL '120 seconds'
        AND n.module = 'calls' AND n.title = 'Missed call' AND n.read_at IS NULL
        AND n.dedupe_key = 'call:' || COALESCE(NULLIF(c.linkedid, ''), c.id::text);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rescue_missed_call ON public.calls;
CREATE TRIGGER trg_rescue_missed_call
  AFTER INSERT OR UPDATE OF disposition ON public.calls
  FOR EACH ROW EXECUTE FUNCTION public.rescue_missed_call_notifications();
