-- 071_push_subscriptions.sql
-- Status: apply to Supabase project qtiscbvhlvdvafwtdtcd.
--
-- Web Push subscriptions for desktop/mobile notifications that fire even when
-- the PWA is closed. One row per browser/device push endpoint; the server
-- (lib/push.ts via web-push + VAPID) sends to these when a notification is
-- created. Dead endpoints (HTTP 404/410) are pruned on send. Service-role only.

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON public.push_subscriptions (user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
-- No policies: only the service-role API routes read/write this.
