-- 121_workshop_quote_detail_expansion.sql
-- Expand the workshop quote / booking / invoice forms toward (and beyond)
-- MechanicDesk parity: richer vehicle-owner, vehicle, and job-detail capture.
--
-- Everything here is additive and nullable, so it's safe on the live tables
-- and existing rows/forms keep working unchanged. New fields are surfaced on
-- the forms behind a "More fields" expander.

-- ── Customer: source of business + structured postal address ──────────────
-- Keep the existing generic `address` for back-compat; add the broken-out
-- suburb/state/postcode MechanicDesk captures.
alter table workshop_customers
  add column if not exists source_of_business text,
  add column if not exists address_suburb     text,
  add column if not exists address_state      text,
  add column if not exists address_postcode   text;

-- ── Vehicle: rego state, series, model code ───────────────────────────────
alter table workshop_vehicles
  add column if not exists rego_state text,
  add column if not exists series     text,
  add column if not exists model_code text;

-- ── Quotes: MechanicDesk quote-detail fields ──────────────────────────────
-- driver_name/phone live on the quote (the person bringing the car can differ
-- from the owner). third_party_customer_id = "Invoice To 3rd Party".
alter table workshop_quotes
  add column if not exists quote_type              text,
  add column if not exists third_party_customer_id uuid references workshop_customers(id) on delete set null,
  add column if not exists short_description       text,
  add column if not exists issue_date              date,
  add column if not exists due_date                date,
  add column if not exists job_types               text[],
  add column if not exists assessed_by             uuid,
  add column if not exists estimated_hours         numeric,
  add column if not exists estimated_by            uuid,
  add column if not exists order_number            text,
  add column if not exists driver_name             text,
  add column if not exists driver_phone            text,
  add column if not exists odometer                integer,
  add column if not exists tags                    text[];

-- ── Bookings: the detail fields not already present ───────────────────────
-- (bookings already have job_type, odometer, description, internal_notes,
--  estimated_value, start/end dates.)
alter table workshop_bookings
  add column if not exists third_party_customer_id uuid references workshop_customers(id) on delete set null,
  add column if not exists job_types               text[],
  add column if not exists assessed_by             uuid,
  add column if not exists estimated_hours         numeric,
  add column if not exists estimated_by            uuid,
  add column if not exists order_number            text,
  add column if not exists driver_name             text,
  add column if not exists driver_phone            text,
  add column if not exists tags                    text[];

-- ── Invoices: issue date, order number, 3rd-party payer, tags ─────────────
alter table workshop_invoices
  add column if not exists issue_date              date,
  add column if not exists order_number            text,
  add column if not exists third_party_customer_id uuid references workshop_customers(id) on delete set null,
  add column if not exists tags                    text[];
