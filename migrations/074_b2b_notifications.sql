-- 074_b2b_notifications.sql
-- Status: apply to Supabase project qtiscbvhlvdvafwtdtcd ("Just Autos Portal").
--
-- Persisted notifications for the distributor portal's bell (order confirmed,
-- shipped, status updates). One row per distributor user per event; written
-- alongside the Web Push. Service-role only.

CREATE TABLE IF NOT EXISTS public.b2b_notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  b2b_user_id UUID NOT NULL REFERENCES public.b2b_distributor_users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body        TEXT,
  href        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_b2b_notifications_user_unread
  ON public.b2b_notifications (b2b_user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_b2b_notifications_user_created
  ON public.b2b_notifications (b2b_user_id, created_at DESC);

ALTER TABLE public.b2b_notifications ENABLE ROW LEVEL SECURITY;
-- No policies: only the service-role API routes read/write this.
