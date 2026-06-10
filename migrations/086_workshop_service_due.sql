-- 086_workshop_service_due.sql
-- Service-due scheduling: next-service / rego due dates on vehicles +
-- automated SMS reminders through the existing workshop_reminders queue.
--
-- The *_reminder_sent_for marker columns are the dedupe mechanism: a reminder
-- is queued only when the due date differs from the marker, so editing a due
-- date automatically re-arms the reminder and repeat cron runs are no-ops.

ALTER TABLE public.workshop_vehicles
  ADD COLUMN IF NOT EXISTS next_service_due_date     DATE,
  ADD COLUMN IF NOT EXISTS next_service_due_km       INT,
  ADD COLUMN IF NOT EXISTS rego_due_date             DATE,
  ADD COLUMN IF NOT EXISTS service_reminder_sent_for DATE,
  ADD COLUMN IF NOT EXISTS rego_reminder_sent_for    DATE;

CREATE INDEX IF NOT EXISTS workshop_vehicles_service_due_idx
  ON public.workshop_vehicles (next_service_due_date) WHERE next_service_due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS workshop_vehicles_rego_due_idx
  ON public.workshop_vehicles (rego_due_date) WHERE rego_due_date IS NOT NULL;

-- VIN search support (Vehicles screen).
CREATE INDEX IF NOT EXISTS workshop_vehicles_vin_idx ON public.workshop_vehicles (lower(vin));

-- How many days before a due date the SMS goes out.
ALTER TABLE public.workshop_settings
  ADD COLUMN IF NOT EXISTS service_reminder_lead_days INT NOT NULL DEFAULT 14;

-- Allow rego reminders through the existing queue (service_due already in 034).
ALTER TABLE public.workshop_reminders DROP CONSTRAINT IF EXISTS workshop_reminders_type_check;
ALTER TABLE public.workshop_reminders ADD CONSTRAINT workshop_reminders_type_check
  CHECK (type IN ('booking', 'ready', 'followup', 'service_due', 'rego_due', 'manual'));
