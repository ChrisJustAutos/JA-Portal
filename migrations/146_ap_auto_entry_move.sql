-- 146_ap_auto_entry_move.sql
-- Record whether a posted invoice's email was filed away (marked read + moved to
-- the "Read /Printed" folder) and, if not, why — so we can diagnose move failures
-- (folder not found, missing Mail.ReadWrite, etc.) from the log instead of guessing.

alter table ap_auto_entry_log
  add column if not exists moved     boolean,
  add column if not exists move_note text;
