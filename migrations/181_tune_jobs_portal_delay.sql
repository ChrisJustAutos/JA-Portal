-- 181: 3-day distributor-portal delay for tune jobs. notified_at marks the
-- delayed "fill in details" notice as sent (email+push move from ingest to a
-- post-delay sweep). Existing jobs were already notified at ingest — stamp
-- them so the sweep doesn't re-email history.
ALTER TABLE public.b2b_tune_jobs ADD COLUMN IF NOT EXISTS notified_at timestamptz;
UPDATE public.b2b_tune_jobs SET notified_at = created_at WHERE notified_at IS NULL;
