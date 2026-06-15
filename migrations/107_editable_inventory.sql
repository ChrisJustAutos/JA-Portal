-- 107: editable inventory items
-- Per-item MYOB sale (income) account override, push/dirty tracking, and a
-- sequence for auto-generating unique internal barcodes. Pricing tiers reuse
-- the existing price_level_2 (Trade) / price_level_3 (Wholesale) columns.

ALTER TABLE workshop_inventory
  ADD COLUMN IF NOT EXISTS sale_account_uid  TEXT,
  ADD COLUMN IF NOT EXISTS sale_account_name TEXT,
  ADD COLUMN IF NOT EXISTS myob_dirty        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS myob_pushed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS myob_push_error   TEXT;

-- Unique internal barcode source (Code 128). Starts at 100001.
CREATE SEQUENCE IF NOT EXISTS workshop_internal_barcode_seq START 100001;

CREATE OR REPLACE FUNCTION next_internal_barcode() RETURNS bigint
  LANGUAGE sql AS $$ SELECT nextval('workshop_internal_barcode_seq') $$;
