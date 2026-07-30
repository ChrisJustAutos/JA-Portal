-- 178_cash_count.sql
-- Cash Count (interim pivot of the Live Bins scale rig, Chris 2026-07-30):
-- weigh coins per denomination on a load-cell module → count + value; till
-- counts saved with expected-vs-counted variance. Applied via Supabase MCP.
CREATE TABLE cash_denominations (
  id             text PRIMARY KEY,          -- '5c', '1d', 'note5' …
  label          text NOT NULL,
  value_cents    int  NOT NULL,
  unit_weight_g  numeric,                   -- null = weigh-count unavailable (manual count only)
  sort           int  NOT NULL DEFAULT 0,
  is_note        boolean NOT NULL DEFAULT false,
  active         boolean NOT NULL DEFAULT true
);

-- Coins: official Royal Australian Mint masses. Notes: ESTIMATES (2026-07-30
-- — no official masses published anywhere; derived from NGB dimensions ×
-- ~90 g/m² Guardian polymer substrate). Good enough to start; true them up
-- with the page's per-denomination "⚖ cal" against a counted stack — beyond
-- ~10 notes an estimate a few % off starts miscounting by 1.
INSERT INTO cash_denominations (id, label, value_cents, unit_weight_g, sort, is_note) VALUES
  ('5c',      '5c',   5,     2.83,  1, false),
  ('10c',     '10c',  10,    5.65,  2, false),
  ('20c',     '20c',  20,    11.30, 3, false),
  ('50c',     '50c',  50,    15.55, 4, false),
  ('1d',      '$1',   100,   9.00,  5, false),
  ('2d',      '$2',   200,   6.60,  6, false),
  ('note5',   '$5',   500,   0.76,  7, true),
  ('note10',  '$10',  1000,  0.80,  8, true),
  ('note20',  '$20',  2000,  0.84,  9, true),
  ('note50',  '$50',  5000,  0.88, 10, true),
  ('note100', '$100', 10000, 0.92, 11, true);

CREATE TABLE cash_counts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  counted_at     timestamptz NOT NULL DEFAULT now(),
  counted_by     text,
  lines          jsonb NOT NULL,             -- [{denom_id, label, count, value_cents, grams, manual}]
  total_cents    int NOT NULL,
  expected_cents int,
  variance_cents int,
  notes          text
);

ALTER TABLE cash_denominations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_counts ENABLE ROW LEVEL SECURITY;
