-- 144_ap_statement_missing_invoices.sql
--
-- Phase 2 of the supplier-statement automation. Phase 1 (migration 136) only
-- REPORTED gaps (invoices on a statement but missing from MYOB). Phase 2 acts
-- on each gap — auto-posts high-confidence finds to MYOB, or emails the supplier
-- to chase a true no-show — and this table is the per-invoice state that keeps
-- those actions idempotent: never double-post, never re-spam a supplier, and
-- flip a gap to resolved once it lands.
--
-- Dedup anchor: (company_file, supplier_uid, invoice_number_norm). The norm is
-- the same normalisation lib/ap-statement-match.normaliseInvoiceNumber applies
-- (uppercase, trimmed, leading zeros stripped, '-' and '/' removed) so the same
-- invoice on next month's statement maps to the same row.

create table if not exists ap_statement_missing_invoices (
  id                  uuid primary key default gen_random_uuid(),
  company_file        text not null check (company_file in ('JAWS','VPS')),
  supplier_uid        text not null,
  supplier_name       text,
  invoice_number      text,                    -- raw, as printed on the statement
  invoice_number_norm text not null,           -- normalised key (see note above)
  invoice_date        date,
  amount              numeric,
  -- Lifecycle:
  --   outstanding       just discovered, not yet actioned this run
  --   posted            auto-posted to (or adopted in) MYOB
  --   emailed_supplier  chased the supplier for the invoice
  --   left_for_review   found in the portal but not safe to auto-post (human to code/post)
  --   no_supplier_email found nowhere AND no address to chase — needs a manual chase
  --   resolved          later confirmed in MYOB (gap closed outside this row's action)
  status              text not null default 'outstanding'
                        check (status in ('outstanding','posted','emailed_supplier','left_for_review','no_supplier_email','resolved')),
  resolution          text,                    -- posted_from_portal | posted_from_inbox | adopted | found_externally
  posted_bill_uid     text,
  posted_invoice_id   uuid,                    -- ap_invoices.id we posted
  supplier_emailed_at timestamptz,
  supplier_email_to   text,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  last_action_at      timestamptz,
  error               text,
  unique (company_file, supplier_uid, invoice_number_norm)
);

create index if not exists ap_stmt_missing_status_idx
  on ap_statement_missing_invoices (status, last_seen_at desc);
create index if not exists ap_stmt_missing_supplier_idx
  on ap_statement_missing_invoices (company_file, supplier_uid);

-- Service-role only (accessed by the cron/watcher via the service key). No
-- anon/auth policies — mirrors ap_statement_scans (migration 136).
alter table ap_statement_missing_invoices enable row level security;
