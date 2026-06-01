-- ═══════════════════════════════════════════════════════════════════
-- 047_b2b_order_automation.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd, then kept for reference.
--
-- Supports auto drop-ship PO + actionable admin notification on paid orders:
--   • b2b_orders.admin_notified_at  — idempotency guard so the Stripe webhook
--     emails the admin order-placed notification exactly once (it can retry).
--   • b2b_settings.admin_order_notify_emails — comma-separated recipient list
--     for that notification, editable in B2B Settings (env fallback in code).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.b2b_orders
  ADD COLUMN IF NOT EXISTS admin_notified_at TIMESTAMPTZ;

ALTER TABLE public.b2b_settings
  ADD COLUMN IF NOT EXISTS admin_order_notify_emails TEXT;
