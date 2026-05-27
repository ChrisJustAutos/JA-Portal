-- ═══════════════════════════════════════════════════════════════════
-- 040_workshop_payments.sql
-- Customer payments taken against a workshop job. Always recorded locally
-- (for paid/balance tracking); posted to MYOB as a Sale/CustomerPayment to
-- the tender's mapped deposit account when MYOB posting is enabled and the
-- job has a MYOB invoice. Service-role-only (RLS on, no policy).
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.workshop_payments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id           UUID NOT NULL REFERENCES public.workshop_bookings(id) ON DELETE CASCADE,
  amount               NUMERIC(12,2) NOT NULL,
  tender               TEXT NOT NULL,            -- cash/eftpos/card/bank_transfer/...
  method               TEXT,                     -- MYOB PaymentMethod
  deposit_account_uid  TEXT,
  deposit_account_name TEXT,
  myob_payment_uid     TEXT,
  posted_to_myob       BOOLEAN NOT NULL DEFAULT false,
  note                 TEXT,
  created_by           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workshop_payments_booking_idx ON public.workshop_payments (booking_id, created_at);
ALTER TABLE public.workshop_payments ENABLE ROW LEVEL SECURITY;
