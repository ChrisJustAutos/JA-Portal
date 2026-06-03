-- 072_b2b_push_subscriptions.sql
-- Status: apply to Supabase project qtiscbvhlvdvafwtdtcd.
--
-- Web Push for the B2B distributor portal — separate from staff push
-- (push_subscriptions, keyed to auth.users) because distributors live in
-- b2b_distributor_users. One row per distributor user's browser/device.
-- Distributors get order-confirmed / shipped / status-update pushes.

CREATE TABLE IF NOT EXISTS public.b2b_push_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  b2b_user_id   UUID NOT NULL REFERENCES public.b2b_distributor_users(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_b2b_push_subscriptions_user ON public.b2b_push_subscriptions (b2b_user_id);

ALTER TABLE public.b2b_push_subscriptions ENABLE ROW LEVEL SECURITY;
-- No policies: only service-role API routes read/write this.
