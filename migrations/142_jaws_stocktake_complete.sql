-- 142_jaws_stocktake_complete.sql
--
-- Add a terminal "completed" state to the JAWS stocktake. After reviewing the
-- variance (and making any adjustment in MYOB by hand), staff click "Mark
-- complete" to close the stocktake out; status moves matched → completed.
-- Reopening clears these back to null.

alter table jaws_stocktake_uploads add column if not exists completed_at timestamptz;
alter table jaws_stocktake_uploads add column if not exists completed_by uuid;
