-- ═══════════════════════════════════════════════════════════════════
-- 033_workshop_settings.sql
-- Singleton settings for the workshop → MYOB invoice push.
--   myob_sales_account_uid  — the JAWS income account workshop sales post to
--                             (Service-sale lines are account-based). Must be
--                             chosen by an admin before invoicing can post.
--   invoice_as_order        — true (default): write a Sale ORDER (sits in
--                             MYOB Orders, NO GL impact; staff convert to an
--                             invoice). false: write a Sale INVOICE (posts GL).
-- Service-role-only (RLS on, no policy).
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.workshop_settings (
  id                      TEXT PRIMARY KEY DEFAULT 'singleton',
  myob_sales_account_uid  TEXT,
  myob_sales_account_name TEXT,
  invoice_as_order        BOOLEAN NOT NULL DEFAULT true,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.workshop_settings (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.workshop_settings ENABLE ROW LEVEL SECURITY;
