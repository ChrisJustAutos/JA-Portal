-- 164_sales_recap_overnight_leads.sql
-- Durable snapshot of quote-channel leads for the Sales Report's Overnight
-- Leads panel. The live Monday pull counts only items CURRENTLY in the
-- "Quote - Lead" group — leads move to Pending/Follow Up as they're worked,
-- so a live pull of a past date range shrinks over time. Every report render
-- (and a half-hourly cron) upserts what it sees; the panel reads these rows,
-- so historical ranges stay correct. First-seen wins: later group moves or
-- renames never rewrite the arrival record.
create table if not exists sales_recap_overnight_leads (
  id               uuid primary key default gen_random_uuid(),
  monday_item_id   text not null,
  board_id         text,
  channel          text not null,          -- Graham / Dom / Tyronne / Kaleb / James
  name             text not null,
  phone            text,
  lead_created_at  timestamptz not null,   -- the Monday item's created_at (arrival time)
  first_seen_at    timestamptz not null default now()
);
create unique index if not exists srol_item_uq on sales_recap_overnight_leads (monday_item_id);
create index if not exists srol_created_idx on sales_recap_overnight_leads (lead_created_at);
