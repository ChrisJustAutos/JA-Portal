-- ═══════════════════════════════════════════════════════════════════
-- 051_label_print_claimed_at.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd, then kept for reference.
--
-- Supports running the label-print agent on MULTIPLE workshop PCs (whichever is
-- on prints the job; the atomic claim guarantees exactly-once). claimed_at lets
-- agents auto-reclaim a job left stuck in 'printing' by a PC that crashed or was
-- switched off mid-print, so another PC retries it.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.label_print_jobs
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
