-- ═══════════════════════════════════════════════════════════════════
-- 031_workshop_core.sql
-- Foundation for the portal-native workshop system that replaces
-- MechanicDesk (Phase 1: diary core). MYOB stays the financial/customer/
-- stock master; the portal owns the operational layer.
--
--   workshop_customers  — synced from MYOB Contacts (myob_uid canonical)
--   workshop_vehicles   — portal-owned (MYOB has no vehicles); holds the
--                         structured service history (history = the jobs
--                         done on a vehicle, each linked to its MYOB invoice)
--   workshop_bookings   — the diary slot (day/week, technician lanes)
--   workshop_jobs       — job card; on completion pushes an invoice to MYOB
--   workshop_job_lines  — labour / part / sublet / fee lines
--
-- All tables are service-role-only (RLS on, no policy): every read/write
-- goes through gated API routes, never the browser. Customer/vehicle PII
-- must not be exposed to the anon key. updated_at is maintained by the API.
-- ═══════════════════════════════════════════════════════════════════

-- ── Customers (mirror of MYOB Contacts) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.workshop_customers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  myob_uid     TEXT UNIQUE,                 -- MYOB Contact UID; null until synced
  name         TEXT NOT NULL,
  first_name   TEXT,
  last_name    TEXT,
  phone        TEXT,
  mobile       TEXT,
  email        TEXT,
  address      TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Vehicles (portal-owned) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workshop_vehicles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID REFERENCES public.workshop_customers(id) ON DELETE SET NULL,
  rego          TEXT,
  make          TEXT,
  model         TEXT,
  year          INT,
  vin           TEXT,
  colour        TEXT,
  engine        TEXT,
  transmission  TEXT,
  odometer      INT,
  notes         TEXT,
  md_vehicle_id TEXT,                        -- original MechanicDesk id (migration trace)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workshop_vehicles_customer_idx ON public.workshop_vehicles (customer_id);
CREATE INDEX IF NOT EXISTS workshop_vehicles_rego_idx ON public.workshop_vehicles (lower(rego));

-- ── Bookings (the diary) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workshop_bookings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID REFERENCES public.workshop_customers(id) ON DELETE SET NULL,
  vehicle_id     UUID REFERENCES public.workshop_vehicles(id) ON DELETE SET NULL,
  starts_at      TIMESTAMPTZ NOT NULL,
  ends_at        TIMESTAMPTZ NOT NULL,
  technician_ext TEXT,                       -- maps to extensions.extension
  bay            TEXT,
  service_type   TEXT,
  status         TEXT NOT NULL DEFAULT 'prebooked'
                   CHECK (status IN ('prebooked','confirmed','in_progress','awaiting_parts','done','invoiced','cancelled','no_show')),
  notes          TEXT,
  created_by     UUID,                        -- user_profiles.id
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workshop_bookings_starts_idx ON public.workshop_bookings (starts_at);
CREATE INDEX IF NOT EXISTS workshop_bookings_tech_idx ON public.workshop_bookings (technician_ext, starts_at);

-- ── Jobs (job card) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workshop_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID REFERENCES public.workshop_bookings(id) ON DELETE SET NULL,
  vehicle_id       UUID REFERENCES public.workshop_vehicles(id) ON DELETE SET NULL,
  customer_id      UUID REFERENCES public.workshop_customers(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','in_progress','completed','invoiced','cancelled')),
  odometer         INT,
  summary          TEXT,
  myob_invoice_uid TEXT,                      -- the MYOB invoice = the dollar record / history link
  total_ex_gst     NUMERIC(12,2),
  total_inc_gst    NUMERIC(12,2),
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workshop_jobs_vehicle_idx ON public.workshop_jobs (vehicle_id, completed_at DESC);

-- ── Job lines (labour / parts) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workshop_job_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            UUID NOT NULL REFERENCES public.workshop_jobs(id) ON DELETE CASCADE,
  line_type         TEXT NOT NULL CHECK (line_type IN ('labour','part','sublet','fee')),
  description       TEXT,
  qty               NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit_price_ex_gst NUMERIC(12,2) NOT NULL DEFAULT 0,
  gst_rate          NUMERIC(5,4) NOT NULL DEFAULT 0.10,
  stock_myob_uid    TEXT,                     -- MYOB Item UID for parts
  total_ex_gst      NUMERIC(12,2),
  sort_order        INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workshop_job_lines_job_idx ON public.workshop_job_lines (job_id, sort_order);

-- ── RLS: service-role-only on all workshop tables ───────────────────
ALTER TABLE public.workshop_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_vehicles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_bookings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_jobs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_job_lines ENABLE ROW LEVEL SECURITY;
