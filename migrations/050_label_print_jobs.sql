-- ═══════════════════════════════════════════════════════════════════
-- 050_label_print_jobs.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd, then kept for reference.
--
-- Print queue for auto-printing freight labels to the workshop DYMO 4XL.
-- The portal enqueues a job when a MachShip label is stored; a self-hosted
-- agent on the workshop PC (like ja-ami-monitor) subscribes via Realtime with
-- the SERVICE-ROLE key, downloads the label PDF from the b2b-shipping-labels
-- bucket, prints it, and marks the job done/failed.
--
-- Mirrors migration 030: service-role-only RLS (holds no public-readable data;
-- both the portal API and the agent use the service-role key) + Realtime
-- publication so the agent receives new jobs.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.label_print_jobs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           UUID REFERENCES public.b2b_orders(id) ON DELETE CASCADE,
  storage_path       TEXT NOT NULL,                 -- path in b2b-shipping-labels bucket
  consignment_number TEXT,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','printing','done','failed')),
  attempts           INT NOT NULL DEFAULT 0,
  error              TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  printed_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS label_print_jobs_status_idx ON public.label_print_jobs (status, created_at);

-- Service-role only (agent + portal use service role; deny anon/authenticated).
ALTER TABLE public.label_print_jobs ENABLE ROW LEVEL SECURITY;

-- Realtime: the agent subscribes to INSERTs. REPLICA IDENTITY FULL so status
-- transitions carry the full row if the agent watches them too. Idempotent.
ALTER TABLE public.label_print_jobs REPLICA IDENTITY FULL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='label_print_jobs'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.label_print_jobs;
    END IF;
  END IF;
END $$;
