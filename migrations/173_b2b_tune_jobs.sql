-- 173: Distributor tune jobs. A Stripe receipt landing in the accounts inbox
-- means a distributor performed a tune. The portal extracts company/VIN/tune
-- details + stores the invoice PDF, then the DISTRIBUTOR fills in the customer
-- details in the B2B portal (weekly reminders until they do). On submit the
-- job fires to Monday + MechanicDesk as a new customer and queues a thank-you
-- letter carrying the distributor's details.

create table if not exists b2b_tune_jobs (
  id uuid primary key default gen_random_uuid(),

  -- Source email (dedup on internet_message_id)
  internet_message_id text unique,
  email_subject text,
  email_from text,
  email_received_at timestamptz,
  invoice_pdf_path text,             -- storage: b2b-tune-invoices bucket
  invoice_number text,
  amount numeric,

  -- Extraction
  company_raw text,                  -- company name as it appears on the invoice
  distributor_id uuid references b2b_distributors(id),
  vin text,
  tune_details text,
  extraction jsonb,                  -- full LLM extraction for debugging

  -- unmatched → awaiting_details → submitted → synced (or dismissed)
  status text not null default 'unmatched'
    check (status in ('unmatched','awaiting_details','submitted','synced','dismissed')),

  -- Customer/job details (filled by the distributor)
  customer_name text,
  customer_first_name text,
  customer_phone text,
  customer_email text,
  customer_address_line1 text,
  customer_suburb text,
  customer_state text,
  customer_postcode text,
  vehicle_rego text,
  vehicle_description text,
  job_notes text,
  filled_by_user_id uuid references b2b_distributor_users(id),
  filled_at timestamptz,

  -- Downstream sync
  monday_item_id text,
  md_customer_md_id text,            -- MechanicDesk customer id once the worker creates it
  md_synced_at timestamptz,
  letter_job_id uuid,
  letter_queued_at timestamptz,
  sync_error text,
  synced_at timestamptz,

  last_reminder_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists b2b_tune_jobs_distributor_idx on b2b_tune_jobs (distributor_id, status);
create index if not exists b2b_tune_jobs_status_idx on b2b_tune_jobs (status);

-- Company-name → distributor merge map ("same merge format of name to
-- Distributor"): unmatched names assigned once in admin stick forever.
create table if not exists b2b_tune_company_aliases (
  company_raw text primary key,      -- stored lowercased/trimmed
  distributor_id uuid not null references b2b_distributors(id),
  created_at timestamptz not null default now()
);

alter table b2b_tune_jobs enable row level security;
alter table b2b_tune_company_aliases enable row level security;

-- Private bucket for the invoice PDFs (signed URLs only)
insert into storage.buckets (id, name, public)
values ('b2b-tune-invoices', 'b2b-tune-invoices', false)
on conflict (id) do nothing;
