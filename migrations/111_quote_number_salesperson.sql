-- 111: human quote number + salesperson on workshop_quotes
CREATE SEQUENCE IF NOT EXISTS workshop_quote_seq START 1000;

ALTER TABLE workshop_quotes
  ADD COLUMN IF NOT EXISTS quote_seq      BIGINT,
  ADD COLUMN IF NOT EXISTS salesperson_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL;

-- Backfill sequential numbers for existing quotes in creation order.
UPDATE workshop_quotes q SET quote_seq = sub.rn
FROM (SELECT id, (1000 + row_number() OVER (ORDER BY created_at, id)) AS rn FROM workshop_quotes WHERE quote_seq IS NULL) sub
WHERE q.id = sub.id AND q.quote_seq IS NULL;

-- Continue the sequence after the highest assigned number.
SELECT setval('workshop_quote_seq', (SELECT GREATEST(COALESCE(MAX(quote_seq), 1000), 1000) FROM workshop_quotes));

-- New rows auto-number.
ALTER TABLE workshop_quotes ALTER COLUMN quote_seq SET DEFAULT nextval('workshop_quote_seq');

-- Seed salesperson from whoever created the quote.
UPDATE workshop_quotes SET salesperson_id = created_by WHERE salesperson_id IS NULL AND created_by IS NOT NULL;
