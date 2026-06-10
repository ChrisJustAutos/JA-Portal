-- 089_workshop_credit_notes.sql
-- Credit notes / refunds against workshop jobs + imported MD invoices.
-- Local-first: a credit note always records locally; when MYOB posting is
-- enabled it also posts as a NEGATIVE Sale/Invoice (never an Order — credits
-- must hit GL), idempotent on myob_credit_uid. Refund money-out rides on
-- workshop_payments as a negative-amount row (kind='refund') so all existing
-- paid/balance sums net off without changes.

CREATE TABLE IF NOT EXISTS public.workshop_credit_notes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cn_seq             BIGINT GENERATED ALWAYS AS IDENTITY,   -- display "CN-{n}"
  booking_id         UUID REFERENCES public.workshop_bookings(id)  ON DELETE SET NULL,
  invoice_id         UUID REFERENCES public.workshop_invoices(id)  ON DELETE SET NULL,
  customer_id        UUID REFERENCES public.workshop_customers(id) ON DELETE SET NULL,
  reason             TEXT,
  kind               TEXT NOT NULL DEFAULT 'lines' CHECK (kind IN ('lines', 'amount')),
  subtotal_ex_gst    NUMERIC(12,2) NOT NULL DEFAULT 0,      -- positive; sign applied at MYOB push
  gst                NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_inc          NUMERIC(12,2) NOT NULL DEFAULT 0,
  restock_parts      BOOLEAN NOT NULL DEFAULT false,
  myob_credit_uid    TEXT,
  myob_credit_number TEXT,
  myob_written_at    TIMESTAMPTZ,
  myob_write_error   TEXT,
  refunded           BOOLEAN NOT NULL DEFAULT false,
  created_by         UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS workshop_credit_notes_booking_idx ON public.workshop_credit_notes (booking_id);
CREATE INDEX IF NOT EXISTS workshop_credit_notes_invoice_idx ON public.workshop_credit_notes (invoice_id);

CREATE TABLE IF NOT EXISTS public.workshop_credit_note_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id    UUID NOT NULL REFERENCES public.workshop_credit_notes(id) ON DELETE CASCADE,
  source_line_id    UUID,                                   -- workshop_booking_lines / workshop_invoice_lines id (no FK)
  line_type         TEXT NOT NULL DEFAULT 'fee' CHECK (line_type IN ('labour', 'part', 'sublet', 'fee')),
  description       TEXT,
  part_number       TEXT,
  qty               NUMERIC(12,2) NOT NULL DEFAULT 1,       -- positive qty being credited
  unit_price_ex_gst NUMERIC(12,2) NOT NULL DEFAULT 0,
  gst_rate          NUMERIC(5,4)  NOT NULL DEFAULT 0.10,
  total_ex_gst      NUMERIC(12,2),
  inventory_id      UUID REFERENCES public.workshop_inventory(id) ON DELETE SET NULL,
  sort_order        INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workshop_cn_lines_idx ON public.workshop_credit_note_lines (credit_note_id, sort_order);

-- Refunds ride on workshop_payments as negative-amount rows.
-- (booking_id is already nullable in prod — imported-invoice refunds carry invoice_id only.)
ALTER TABLE public.workshop_payments
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'payment',
  ADD COLUMN IF NOT EXISTS credit_note_id UUID REFERENCES public.workshop_credit_notes(id) ON DELETE SET NULL;

DROP TRIGGER IF EXISTS workshop_cn_set_updated ON public.workshop_credit_notes;
CREATE TRIGGER workshop_cn_set_updated BEFORE UPDATE ON public.workshop_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.crm_set_updated_at();

ALTER TABLE public.workshop_credit_notes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_credit_note_lines ENABLE ROW LEVEL SECURITY;
