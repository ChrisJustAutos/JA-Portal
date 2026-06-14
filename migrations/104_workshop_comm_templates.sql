-- 104_workshop_comm_templates.sql
-- Editable customer communication templates (SMS + email) with per-template
-- timing + job-type rules. Replaces the hard-coded reminder bodies in
-- lib/workshop-reminders.ts. The workshop_reminders queue gains email support
-- (channel/to_email/subject) and a template link so each send is traceable.
--
-- Triggers:
--   booking_confirmation — sent when a booking is created (offset from start)
--   booking_reminder     — before the booking (offset_dir 'before')
--   ready                — "ready for collection" (manual "Text customer" prefill)
--   follow_up            — after job completion (offset_dir 'after'), job-type gated
--   service_due / rego_due — when a vehicle's due date enters the lead window
--
-- Sends are still globally gated by workshop_settings.sms_enabled; a template
-- must ALSO be enabled. Service-role only (RLS on, no policy).

CREATE TABLE IF NOT EXISTS public.workshop_comm_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger      TEXT NOT NULL CHECK (trigger IN ('booking_confirmation','booking_reminder','ready','follow_up','service_due','rego_due')),
  name         TEXT NOT NULL,
  channel      TEXT NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms','email')),
  subject      TEXT,                                   -- email only
  body         TEXT NOT NULL DEFAULT '',
  enabled      BOOLEAN NOT NULL DEFAULT false,
  offset_value INT NOT NULL DEFAULT 0,                 -- magnitude of the timing offset
  offset_unit  TEXT NOT NULL DEFAULT 'days' CHECK (offset_unit IN ('hours','days')),
  offset_dir   TEXT NOT NULL DEFAULT 'before' CHECK (offset_dir IN ('before','after')),
  job_types    TEXT[] NOT NULL DEFAULT '{}',           -- empty = all job types
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.workshop_comm_templates ENABLE ROW LEVEL SECURITY;

-- workshop_reminders: carry email sends + the originating template.
ALTER TABLE public.workshop_reminders
  ADD COLUMN IF NOT EXISTS channel     TEXT NOT NULL DEFAULT 'sms',
  ADD COLUMN IF NOT EXISTS to_email    TEXT,
  ADD COLUMN IF NOT EXISTS subject     TEXT,
  ADD COLUMN IF NOT EXISTS template_id UUID;
-- Widen the type check (rego_due/follow_up/booking_confirmation were never in it).
ALTER TABLE public.workshop_reminders DROP CONSTRAINT IF EXISTS workshop_reminders_type_check;
ALTER TABLE public.workshop_reminders ADD CONSTRAINT workshop_reminders_type_check
  CHECK (type IN ('booking','booking_confirmation','ready','followup','follow_up','service_due','rego_due','manual'));

-- Seed sensible defaults (only if the table is empty). booking_reminder +
-- service/rego due start enabled (they match the old hard-coded behaviour);
-- confirmation + follow-up are opt-in.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workshop_comm_templates) THEN
    INSERT INTO public.workshop_comm_templates (trigger, name, channel, body, enabled, offset_value, offset_unit, offset_dir, sort_order) VALUES
     ('booking_confirmation','Booking confirmation','sms','Hi {{first_name}}, your {{vehicle}} is booked in at {{business_name}} on {{date}} at {{time}}. Call us if you need to change it.', false, 0,'days','after', 1),
     ('booking_reminder','Booking reminder','sms','Hi {{first_name}}, a reminder your {{vehicle}} is booked in at {{business_name}} on {{date}} at {{time}}. Call us if you need to reschedule.', true, 1,'days','before', 2),
     ('ready','Ready for collection','sms','Hi {{first_name}}, your {{vehicle}} is ready for collection at {{business_name}}.', true, 0,'days','after', 3),
     ('follow_up','Service follow-up','sms','Hi {{first_name}}, thanks for choosing {{business_name}} for your {{vehicle}}. How did everything go? Reply or call us if we can help with anything.', false, 3,'days','after', 4),
     ('service_due','Service due','sms','Hi {{first_name}}, your {{vehicle}} is due for a service on {{due_date}}. Call {{business_name}} to book it in.', true, 0,'days','after', 5),
     ('rego_due','Registration due','sms','Hi {{first_name}}, your {{vehicle}} registration is due on {{due_date}}. Call {{business_name}} if we can help.', true, 0,'days','after', 6);
  END IF;
END $$;
