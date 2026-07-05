-- 150_ap_auto_entry_context.sql
--
-- AP auto-entry log: record the email + attachment context on EVERY row so
-- "why didn't invoice X post?" is answerable from the log alone. Until now
-- skipped/errored rows saved only opaque Graph ids, which made a silently
-- skipped invoice (e.g. a non-invoice parse) impossible to identify later.

alter table ap_auto_entry_log
  add column if not exists subject text,
  add column if not exists from_address text,
  add column if not exists attachment_name text;
