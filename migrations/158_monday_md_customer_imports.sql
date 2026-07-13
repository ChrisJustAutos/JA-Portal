-- 158_monday_md_customer_imports.sql
-- Nightly Monday quote-channel lead -> MechanicDesk customer import log
-- (scripts/import-monday-leads.ts). One row per Monday item examined;
-- unique(monday_item_id) makes the import idempotent across runs.
create table if not exists monday_md_customer_imports (
  id               uuid primary key default gen_random_uuid(),
  monday_item_id   text not null unique,
  monday_board_id  text not null,
  channel          text,
  customer_name    text not null,
  phone            text,
  email            text,
  postcode         text,
  outcome          text not null check (outcome in ('created','exists_md','exists_portal','skipped','error')),
  md_customer_id   text,
  error            text,
  created_at       timestamptz not null default now()
);
create index if not exists monday_md_imports_outcome on monday_md_customer_imports (outcome, created_at desc);
