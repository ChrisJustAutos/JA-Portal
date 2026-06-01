-- ═══════════════════════════════════════════════════════════════════
-- 056_b2b_freight_book_schedule.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd, then kept for reference.
--
-- "Book later" from the admin Book-Freight email: instead of booking now, the
-- admin can schedule the booking for a later time. The b2b-freight-poll cron
-- sweeps due rows and books them.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.b2b_orders
  ADD COLUMN IF NOT EXISTS freight_book_scheduled_at TIMESTAMPTZ;
