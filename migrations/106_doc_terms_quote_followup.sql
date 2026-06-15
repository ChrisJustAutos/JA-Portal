-- 106_doc_terms_quote_followup.sql
-- (1) Editable document templates: terms/payment-details text blocks for
--     invoices, quotes and purchase orders (render above the footer).
-- (2) Quote follow-up comms: a quote_follow_up trigger + a quote link on the
--     reminders queue so unaccepted quotes can be auto-chased.

ALTER TABLE public.workshop_settings
  ADD COLUMN IF NOT EXISTS invoice_terms TEXT,
  ADD COLUMN IF NOT EXISTS quote_terms   TEXT,
  ADD COLUMN IF NOT EXISTS po_terms      TEXT;

ALTER TABLE public.workshop_comm_templates DROP CONSTRAINT IF EXISTS workshop_comm_templates_trigger_check;
ALTER TABLE public.workshop_comm_templates ADD CONSTRAINT workshop_comm_templates_trigger_check
  CHECK (trigger IN ('booking_confirmation','booking_reminder','ready','follow_up','review_request','payment_receipt','quote_follow_up','service_due','rego_due'));

ALTER TABLE public.workshop_reminders DROP CONSTRAINT IF EXISTS workshop_reminders_type_check;
ALTER TABLE public.workshop_reminders ADD CONSTRAINT workshop_reminders_type_check
  CHECK (type IN ('booking','booking_confirmation','ready','followup','follow_up','review_request','payment_receipt','quote_follow_up','service_due','rego_due','manual'));
ALTER TABLE public.workshop_reminders ADD COLUMN IF NOT EXISTS quote_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workshop_comm_templates WHERE trigger = 'quote_follow_up') THEN
    INSERT INTO public.workshop_comm_templates (trigger, name, channel, body, enabled, offset_value, offset_unit, offset_dir, sort_order) VALUES
     ('quote_follow_up','Quote follow-up','sms','Hi {{first_name}}, just following up on the quote for your {{vehicle}} ({{total}}). Happy to answer any questions or get you booked in — {{business_name}}.', false, 3,'days','after', 9);
  END IF;
END $$;
