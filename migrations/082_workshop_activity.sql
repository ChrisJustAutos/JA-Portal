-- ═══════════════════════════════════════════════════════════════════
-- 082_workshop_activity.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd ("Just Autos Portal").
--
-- Workshop activity log — a cross-entity audit feed (ported concept from the
-- autodesk_pro prototype). Records create/update/split/convert/payment events
-- on bookings, quotes, customers, etc. so staff can see "who did what, when".
-- Written best-effort from the workshop API routes; viewed at /workshop/activity.
-- RLS enabled, service-role only.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.workshop_activity (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action        TEXT NOT NULL,                 -- created | updated | deleted | split | converted | payment | status
  entity        TEXT NOT NULL,                 -- booking | quote | customer | vehicle | inventory | invoice | payment
  entity_id     UUID,
  entity_label  TEXT,                          -- human label (customer name, quote #, etc.)
  detail        TEXT,                          -- free-text summary of the change
  actor_id      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  actor_name    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workshop_activity_created_idx ON public.workshop_activity (created_at DESC);
CREATE INDEX IF NOT EXISTS workshop_activity_entity_idx ON public.workshop_activity (entity, created_at DESC);

ALTER TABLE public.workshop_activity ENABLE ROW LEVEL SECURITY;
