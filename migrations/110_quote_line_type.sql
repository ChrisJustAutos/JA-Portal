-- 110: quote lines get a line_type so quotes can have 'description' heading
-- rows between items, mirroring the job-card invoice layout.
ALTER TABLE workshop_quote_lines
  ADD COLUMN IF NOT EXISTS line_type TEXT NOT NULL DEFAULT 'item';
