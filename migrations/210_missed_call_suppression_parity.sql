-- 210_missed_call_suppression_parity.sql
--
-- Missed-call notifications still fire on ring-group pickups (Chris,
-- 2026-08-31). The RETRACTION (167) then deletes them, so the bell ends up
-- correct - but the notification has already appeared, which is what people
-- actually experience.
--
-- Two gaps, both in the INSERT-time suppression, which never got the
-- improvements 167 made to the retraction:
--
--   1. It compares external_number with '=' while the retraction matches on
--      the LAST 9 DIGITS. Asterisk writes the same caller as 0419... on one
--      leg and 61419... on another, so an exact match misses the sibling and
--      the notification fires.
--   2. It never checks the LINKEDID. The most direct evidence that this is the
--      un-answered leg of a ring-group pickup is that another row for the same
--      call is answered.
--
-- Measured over the 5 days to 2026-08-31: 78 unanswered inbound calls, 67 of
-- which still notify. The 11 suppressed are ones the exact-match rule let past.
--
-- This does NOT fix the in-flight case: Asterisk writes the answered leg's CDR
-- row at HANGUP, so during a live call only the NO ANSWER legs exist and the
-- sync legitimately classifies it missed. That needs the sync to skip calls
-- whose channel is still up - a change on the PBX, not here.

CREATE OR REPLACE FUNCTION public.notify_missed_call()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  digits text := regexp_replace(COALESCE(NEW.external_number, ''), '\D', '', 'g');
BEGIN
  IF NEW.direction = 'inbound'
     AND COALESCE(NEW.disposition, '') <> 'ANSWERED'
     AND COALESCE(NEW.billsec_seconds, 0) = 0        -- talk time means answered
     AND NEW.call_date > now() - INTERVAL '2 hours'
     AND NOT EXISTS (
       SELECT 1 FROM calls s
       WHERE s.linkedid IS NOT NULL AND NEW.linkedid IS NOT NULL
         AND s.linkedid = NEW.linkedid
         AND s.id <> NEW.id
         AND s.disposition = 'ANSWERED'
     )
     AND (digits = '' OR length(digits) < 6 OR NOT EXISTS (
       SELECT 1 FROM calls a
       WHERE a.direction = 'inbound'
         AND a.disposition = 'ANSWERED'
         AND right(regexp_replace(COALESCE(a.external_number, ''), '\D', '', 'g'), 9) = right(digits, 9)
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
