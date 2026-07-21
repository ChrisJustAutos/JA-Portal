-- 167_missed_call_rescue_window.sql
-- Missed-call notifications: widen the rescue.
--
-- Migration 154's ±120s rule only covers SIMULTANEOUS ring-group legs.
-- Real pattern (Chris 2026-07-21, e.g. 0448907180): caller misses at 10:10,
-- rings back at 10:22 and is answered — the stale "Missed call" bell stayed.
-- Now ANY answered contact with that number — inbound ring-back OR an
-- outbound callback by staff — retracts unread missed-call notifications
-- for the same number from the previous 4 hours. Insert-time suppression
-- stays at ±120s so a genuinely-new miss after an old conversation still
-- notifies.

CREATE OR REPLACE FUNCTION public.rescue_missed_call_notifications()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.disposition = 'ANSWERED' THEN
    -- The leg itself flipped missed → answered (upsert on linkedid).
    IF NEW.direction = 'inbound' THEN
      DELETE FROM notifications n
      WHERE n.module = 'calls' AND n.title = 'Missed call' AND n.read_at IS NULL
        AND n.dedupe_key = 'call:' || COALESCE(NULLIF(NEW.linkedid, ''), NEW.id::text);
    END IF;
    -- Any answered contact (inbound ring-back or outbound callback) clears
    -- unread missed flags for the same number over the last 4 hours.
    -- Number match on the last 9 digits to survive 04… / 614… formats.
    IF COALESCE(NEW.external_number, '') <> '' AND length(regexp_replace(NEW.external_number, '\D', '', 'g')) >= 6 THEN
      DELETE FROM notifications n
      USING calls c
      WHERE c.direction = 'inbound'
        AND COALESCE(c.disposition, '') <> 'ANSWERED'
        AND right(regexp_replace(COALESCE(c.external_number, ''), '\D', '', 'g'), 9)
            = right(regexp_replace(NEW.external_number, '\D', '', 'g'), 9)
        AND c.call_date BETWEEN NEW.call_date - INTERVAL '4 hours'
                            AND NEW.call_date + INTERVAL '120 seconds'
        AND n.module = 'calls' AND n.title = 'Missed call' AND n.read_at IS NULL
        AND n.dedupe_key = 'call:' || COALESCE(NULLIF(c.linkedid, ''), c.id::text);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Re-point the trigger (drops the inbound-only assumption baked into 154's
-- function body; the trigger events are unchanged).
DROP TRIGGER IF EXISTS trg_rescue_missed_call ON public.calls;
CREATE TRIGGER trg_rescue_missed_call
  AFTER INSERT OR UPDATE OF disposition ON public.calls
  FOR EACH ROW EXECUTE FUNCTION public.rescue_missed_call_notifications();
