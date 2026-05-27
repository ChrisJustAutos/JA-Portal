-- ═══════════════════════════════════════════════════════════════════
-- 034_workshop_reminders.sql
-- SMS reminders (ClickSend) for the workshop. A queue the cron drains, plus
-- workshop_settings flags. Service-role-only (RLS on, no policy).
--
--   workshop_settings.sms_enabled                 — master switch for AUTO
--                                                    reminders (default off)
--   workshop_settings.sms_from                    — optional ClickSend sender
--   workshop_settings.booking_reminder_lead_hours — how far ahead to text
--   workshop_reminders                            — the send queue / log
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.workshop_settings
  ADD COLUMN IF NOT EXISTS sms_enabled                 BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sms_from                    TEXT,
  ADD COLUMN IF NOT EXISTS booking_reminder_lead_hours INT NOT NULL DEFAULT 24;

CREATE TABLE IF NOT EXISTS public.workshop_reminders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type                 TEXT NOT NULL CHECK (type IN ('booking','ready','followup','service_due','manual')),
  customer_id          UUID REFERENCES public.workshop_customers(id) ON DELETE SET NULL,
  vehicle_id           UUID REFERENCES public.workshop_vehicles(id) ON DELETE SET NULL,
  booking_id           UUID REFERENCES public.workshop_bookings(id) ON DELETE SET NULL,
  to_number            TEXT,
  body                 TEXT NOT NULL,
  send_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','cancelled')),
  clicksend_message_id TEXT,
  error                TEXT,
  sent_at              TIMESTAMPTZ,
  created_by           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workshop_reminders_due_idx ON public.workshop_reminders (send_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS workshop_reminders_booking_idx ON public.workshop_reminders (booking_id);

ALTER TABLE public.workshop_reminders ENABLE ROW LEVEL SECURITY;
