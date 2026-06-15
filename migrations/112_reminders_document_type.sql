-- 112: allow 'document' reminder type so emailed PDFs (quote/invoice/job card/PO)
-- are recorded in the comms history.
ALTER TABLE public.workshop_reminders DROP CONSTRAINT IF EXISTS workshop_reminders_type_check;
ALTER TABLE public.workshop_reminders ADD CONSTRAINT workshop_reminders_type_check
  CHECK (type IN ('booking','booking_confirmation','ready','followup','follow_up','review_request','payment_receipt','quote_follow_up','service_due','rego_due','manual','document'));
