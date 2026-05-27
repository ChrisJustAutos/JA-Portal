-- ═══════════════════════════════════════════════════════════════════
-- 032_workshop_from_autodesk.sql
-- Bring the autodesk_pro (Flutter prototype) data model into the portal,
-- reconciled with the Phase-1 workshop_* tables (still empty).
--
-- Key reconciliation: the prototype unifies booking + job into ONE entity
-- (its `Jobs` table = a diary slot with a status that flows
-- booking → in_progress → invoiced → paid, plus job_type/description/
-- estimated_value and span_techs for multi-tech jobs). We fold that into
-- workshop_bookings (which already carries the diary slot) and drop the
-- unused separate jobs/job_lines split in favour of booking-attached lines.
--
-- Adds the rest of the prototype's model: inventory (MYOB-shaped), quotes +
-- lines, invoices (local record; MYOB stays authoritative), diary notes,
-- tasks. All service-role-only (RLS on, no policy).
-- ═══════════════════════════════════════════════════════════════════

-- ── Customers: + type / company / number ────────────────────────────
ALTER TABLE public.workshop_customers
  ADD COLUMN IF NOT EXISTS customer_type   TEXT NOT NULL DEFAULT 'individual',
  ADD COLUMN IF NOT EXISTS company         TEXT,
  ADD COLUMN IF NOT EXISTS customer_number TEXT;

-- ── Bookings become the unified job/diary entity ────────────────────
ALTER TABLE public.workshop_bookings
  ADD COLUMN IF NOT EXISTS job_type         TEXT NOT NULL DEFAULT 'general_service',
  ADD COLUMN IF NOT EXISTS description      TEXT,
  ADD COLUMN IF NOT EXISTS internal_notes   TEXT,
  ADD COLUMN IF NOT EXISTS estimated_value  NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS span_techs       TEXT,          -- comma-sep extra technician exts
  ADD COLUMN IF NOT EXISTS is_overdue       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS odometer         INT,
  ADD COLUMN IF NOT EXISTS summary          TEXT,
  ADD COLUMN IF NOT EXISTS myob_invoice_uid TEXT,
  ADD COLUMN IF NOT EXISTS total_ex_gst     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS total_inc_gst    NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS completed_at     TIMESTAMPTZ;

ALTER TABLE public.workshop_bookings DROP CONSTRAINT IF EXISTS workshop_bookings_status_check;
ALTER TABLE public.workshop_bookings ADD CONSTRAINT workshop_bookings_status_check
  CHECK (status IN ('prebooked','booking','confirmed','in_progress','awaiting_parts','ready','done','invoiced','paid','cancelled','no_show'));

-- ── Replace unused jobs/job_lines split with booking-attached lines ──
DROP TABLE IF EXISTS public.workshop_job_lines;
DROP TABLE IF EXISTS public.workshop_jobs;

-- ── Inventory (MYOB-shaped, mirrors autodesk InventoryItems) ────────
-- (created before workshop_booking_lines, which references it)
CREATE TABLE IF NOT EXISTS public.workshop_inventory (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  myob_uid             TEXT UNIQUE,
  sku                  TEXT,
  part_name            TEXT NOT NULL,
  sale_description     TEXT,
  purchase_description TEXT,
  category             TEXT,
  brand                TEXT,
  barcode              TEXT,
  buy_price            NUMERIC(12,2) NOT NULL DEFAULT 0,
  sell_price           NUMERIC(12,2) NOT NULL DEFAULT 0,
  markup_pct           NUMERIC(8,2)  NOT NULL DEFAULT 0,
  price_level_2        NUMERIC(12,2),
  price_level_3        NUMERIC(12,2),
  price_level_4        NUMERIC(12,2),
  quantity             NUMERIC(12,2) NOT NULL DEFAULT 0,
  available            NUMERIC(12,2) NOT NULL DEFAULT 0,
  allocated            NUMERIC(12,2) NOT NULL DEFAULT 0,
  on_order             NUMERIC(12,2) NOT NULL DEFAULT 0,
  alert_qty            NUMERIC(12,2) NOT NULL DEFAULT 0,
  reorder_qty          NUMERIC(12,2) NOT NULL DEFAULT 0,
  max_qty              NUMERIC(12,2),
  location             TEXT,
  bin                  TEXT,
  supplier             TEXT,
  uom                  TEXT,
  is_non_stock         BOOLEAN NOT NULL DEFAULT false,
  deactivated          BOOLEAN NOT NULL DEFAULT false,
  last_sales_date      TEXT,
  last_purchase_date   TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workshop_inventory_sku_idx  ON public.workshop_inventory (lower(sku));
CREATE INDEX IF NOT EXISTS workshop_inventory_name_idx ON public.workshop_inventory (lower(part_name));

CREATE TABLE IF NOT EXISTS public.workshop_booking_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        UUID NOT NULL REFERENCES public.workshop_bookings(id) ON DELETE CASCADE,
  line_type         TEXT NOT NULL DEFAULT 'labour' CHECK (line_type IN ('labour','part','sublet','fee')),
  description       TEXT,
  part_number       TEXT,
  qty               NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit_price_ex_gst NUMERIC(12,2) NOT NULL DEFAULT 0,
  gst_rate          NUMERIC(5,4) NOT NULL DEFAULT 0.10,
  inventory_id      UUID REFERENCES public.workshop_inventory(id) ON DELETE SET NULL,
  total_ex_gst      NUMERIC(12,2),
  sort_order        INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workshop_booking_lines_idx ON public.workshop_booking_lines (booking_id, sort_order);

-- ── Quotes + lines ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workshop_quotes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID REFERENCES public.workshop_customers(id) ON DELETE SET NULL,
  vehicle_id   UUID REFERENCES public.workshop_vehicles(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','sent','accepted','declined','expired','converted')),
  subtotal     NUMERIC(12,2) NOT NULL DEFAULT 0,
  gst          NUMERIC(12,2) NOT NULL DEFAULT 0,
  total        NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes        TEXT,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.workshop_quote_lines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id     UUID NOT NULL REFERENCES public.workshop_quotes(id) ON DELETE CASCADE,
  description  TEXT,
  part_number  TEXT,
  qty          NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit_price   NUMERIC(12,2) NOT NULL DEFAULT 0,
  inventory_id UUID REFERENCES public.workshop_inventory(id) ON DELETE SET NULL,
  sort_order   INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS workshop_quote_lines_idx ON public.workshop_quote_lines (quote_id, sort_order);

-- ── Invoices (local record; MYOB holds the authoritative invoice) ───
CREATE TABLE IF NOT EXISTS public.workshop_invoices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      UUID REFERENCES public.workshop_customers(id) ON DELETE SET NULL,
  booking_id       UUID REFERENCES public.workshop_bookings(id) ON DELETE SET NULL,
  myob_invoice_uid TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','sent','paid','overdue','void')),
  subtotal         NUMERIC(12,2) NOT NULL DEFAULT 0,
  gst              NUMERIC(12,2) NOT NULL DEFAULT 0,
  total            NUMERIC(12,2) NOT NULL DEFAULT 0,
  due_date         TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Diary notes (calendar annotations spanning a date range) ────────
CREATE TABLE IF NOT EXISTS public.workshop_diary_notes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content       TEXT NOT NULL,
  author_name   TEXT,
  note_date     TIMESTAMPTZ NOT NULL,
  note_end_date TIMESTAMPTZ,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workshop_diary_notes_date_idx ON public.workshop_diary_notes (note_date);

-- ── Tasks ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workshop_tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  assignee    TEXT,
  status      TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done','cancelled')),
  priority    TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  category    TEXT,
  notes       TEXT,
  due_date    TIMESTAMPTZ,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── RLS: service-role-only on all new tables ────────────────────────
ALTER TABLE public.workshop_booking_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_inventory     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_quotes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_quote_lines   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_invoices      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_diary_notes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_tasks         ENABLE ROW LEVEL SECURITY;
