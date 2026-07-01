-- 145_ap_auto_entry_log.sql
--
-- Automated invoice entry (VPS). A background cron reads supplier invoices from
-- the VPS accounts inbox, fact-checks them, and either posts them straight to
-- MYOB (no portal ap_invoices row) or flags them in Slack and leaves the email.
-- This table is the dedup anchor + audit trail: one row per processed
-- (email message, attachment) so the cron never re-posts or re-Slacks the same
-- invoice, and we can see what the automation did.

create table if not exists ap_auto_entry_log (
  id                   uuid primary key default gen_random_uuid(),
  mailbox              text not null,
  company_file         text not null check (company_file in ('VPS','JAWS')),
  graph_message_id     text not null,
  graph_attachment_id  text not null,
  supplier_name        text,
  supplier_uid         text,
  invoice_number       text,
  invoice_date         date,
  amount               numeric,
  -- What the run did with this attachment:
  --   posted              fact-check passed → bill created (or adopted) in MYOB
  --   flagged             invoice-like but failed the fact-check → Slack flag, email left
  --   skipped_not_invoice attachment isn't an invoice (no number+total) → silent
  --   error               unexpected failure while processing
  outcome              text not null check (outcome in ('posted','flagged','skipped_not_invoice','error')),
  fail_reasons         jsonb,
  -- Bank-details verification vs the MYOB supplier card:
  --   match | mismatch | unverified (card has none) | no-invoice-bank | skipped
  bank_check           text,
  myob_bill_uid        text,
  pdf_storage_path     text,          -- staged copy for the Slack link (auto-entry/<id>.pdf)
  slack_ts             text,
  error                text,
  created_at           timestamptz not null default now(),
  unique (graph_message_id, graph_attachment_id)
);

create index if not exists ap_auto_entry_log_created_idx on ap_auto_entry_log (created_at desc);
create index if not exists ap_auto_entry_log_outcome_idx on ap_auto_entry_log (outcome, created_at desc);

-- Service-role only (accessed by the cron via the service key). Mirrors
-- ap_statement_scans / ap_statement_missing_invoices.
alter table ap_auto_entry_log enable row level security;
