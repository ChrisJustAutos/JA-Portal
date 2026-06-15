-- 105_comm_templates_more_triggers.sql
-- More comm-template triggers: payment_receipt (sent when a payment is taken)
-- and review_request (after completion, like follow-up, carries {{review_link}}).
-- Plus workshop_settings.review_url for the {{review_link}} placeholder.

ALTER TABLE public.workshop_comm_templates DROP CONSTRAINT IF EXISTS workshop_comm_templates_trigger_check;
ALTER TABLE public.workshop_comm_templates ADD CONSTRAINT workshop_comm_templates_trigger_check
  CHECK (trigger IN ('booking_confirmation','booking_reminder','ready','follow_up','review_request','payment_receipt','service_due','rego_due'));

ALTER TABLE public.workshop_reminders DROP CONSTRAINT IF EXISTS workshop_reminders_type_check;
ALTER TABLE public.workshop_reminders ADD CONSTRAINT workshop_reminders_type_check
  CHECK (type IN ('booking','booking_confirmation','ready','followup','follow_up','review_request','payment_receipt','service_due','rego_due','manual'));

ALTER TABLE public.workshop_settings ADD COLUMN IF NOT EXISTS review_url TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workshop_comm_templates WHERE trigger = 'payment_receipt') THEN
    INSERT INTO public.workshop_comm_templates (trigger, name, channel, body, enabled, offset_value, offset_unit, offset_dir, sort_order) VALUES
     ('payment_receipt','Payment receipt','sms','Hi {{first_name}}, thanks — we''ve received your payment of {{amount}} for {{vehicle}}. Balance: {{balance}}. {{business_name}}', false, 0,'days','after', 7);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workshop_comm_templates WHERE trigger = 'review_request') THEN
    INSERT INTO public.workshop_comm_templates (trigger, name, channel, body, enabled, offset_value, offset_unit, offset_dir, sort_order) VALUES
     ('review_request','Review request','sms','Hi {{first_name}}, thanks for choosing {{business_name}}! If you have a minute we''d really appreciate a quick review: {{review_link}}', false, 2,'days','after', 8);
  END IF;
END $$;
