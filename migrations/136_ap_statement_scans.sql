-- 136_ap_statement_scans.sql
-- Dedupe + audit log for the automated supplier-statement watcher. Each row is
-- one statement PDF attachment we've reconciled against MYOB, so a daily scan
-- never re-processes (or re-emails) the same statement. Service-role only.

create table if not exists public.ap_statement_scans (
  id                   uuid primary key default gen_random_uuid(),
  mailbox              text not null,
  company_file         text not null,                 -- 'JAWS' | 'VPS'
  graph_message_id     text not null,
  graph_attachment_id  text not null,
  attachment_name      text,
  subject              text,
  from_address         text,
  supplier_name        text,                           -- extracted from the statement
  supplier_uid         text,                           -- resolved MYOB supplier (null if unmatched)
  match_status         text,                           -- reconciled | has_missing | needs_review | failed
  invoice_lines        integer not null default 0,
  missing_count        integer not null default 0,
  missing              jsonb,                           -- [{ reference, date, amount }]
  error                text,
  reported             boolean not null default false,  -- included in a sent digest
  scanned_at           timestamptz not null default now(),
  unique (graph_message_id, graph_attachment_id)
);
create index if not exists ap_statement_scans_recent_idx on public.ap_statement_scans (scanned_at desc);

alter table public.ap_statement_scans enable row level security;
