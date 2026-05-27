-- ═══════════════════════════════════════════════════════════════════
-- 041_workshop_labour_item.sql
-- The MYOB "Labour" service item used for non-part lines (labour/sublet/fees)
-- so a job invoice can be posted as an all-Item sale — parts decrement stock +
-- book COGS, while keeping the invoice editable in MYOB (avoids the read-only
-- "hybrid layout" that mixing Item + account lines triggers). When set, the
-- invoice push uses Item lines; otherwise it falls back to account lines.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.workshop_settings
  ADD COLUMN IF NOT EXISTS labour_item_uid  TEXT,
  ADD COLUMN IF NOT EXISTS labour_item_name TEXT;
