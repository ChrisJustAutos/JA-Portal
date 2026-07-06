-- 152_workshop_map.sql
--
-- Workshop Map & Conversion report (Reports → Map & conversion).
-- A daily GitHub-Actions worker (scripts/pull-md-workshop-map.ts) exports the
-- FULL MechanicDesk Invoices + Quotes reports (Workshop 5108), classifies each
-- record's vehicle series + geocodes it (postcode → lat/lng), and POSTs:
--   • every fact row  → md_invoices / md_quotes (idempotent upsert on number)
--   • one prebuilt dashboard payload per FY → md_workshop_map_cache
-- The read API (/api/workshop/map) is then a single cache SELECT.
--
-- Full refresh daily = self-healing: quote status changes, late edits and
-- back-dated records reconcile without drift. Rows that vanish from MD are
-- soft-flagged (missing = true), never hard-deleted.

-- ── Fact: MD invoices (jobs) ────────────────────────────────────────────
create table if not exists md_invoices (
  invoice_number text primary key,
  customer_id    text,
  customer_name  text,
  suburb         text,
  state          text,
  postcode       text,
  vehicle_id     text,
  rego           text,
  first_job_type text,
  description    text,
  items_text     text,               -- space-joined line-item Description+Details+Stock Name+Stock Number
  issue_date     date,
  total_amount   numeric not null default 0,
  -- computed at ingest (lib/workshop-map/vehicle-classification.ts):
  vehicle_group  text,               -- 70 | 200 | 300 | HILUX | PRADO | LCNA | OTH
  inferred       boolean not null default false,
  is_noise       boolean not null default false,  -- deposit/diagnostic/toll/$0/internal — excluded from "clear jobs"
  lat            double precision,
  lng            double precision,
  locality       text,
  month          text,               -- YYYY-MM
  fy             integer,            -- AU FY (Jul 2025 → 2026)
  -- sync bookkeeping:
  last_seen_at   timestamptz not null default now(),
  missing        boolean not null default false,  -- no longer present in the MD export
  updated_at     timestamptz not null default now()
);
create index if not exists md_invoices_fy_month_group on md_invoices (fy, month, vehicle_group);
create index if not exists md_invoices_customer on md_invoices (customer_id);

-- ── Fact: MD quotes ─────────────────────────────────────────────────────
create table if not exists md_quotes (
  quote_number   text primary key,
  customer_id    text,
  customer_name  text,
  suburb         text,
  state          text,
  postcode       text,
  rego           text,
  vehicle_model  text,
  description    text,
  items_text     text,
  quote_date     date,
  total_amount   numeric not null default 0,
  status         text,
  won            boolean not null default false,  -- status-derived, reference only (NOT used for conversion)
  vehicle_group  text,
  inferred       boolean not null default false,
  lat            double precision,
  lng            double precision,
  locality       text,
  month          text,
  fy             integer,
  last_seen_at   timestamptz not null default now(),
  missing        boolean not null default false,
  updated_at     timestamptz not null default now()
);
create index if not exists md_quotes_fy_month_group on md_quotes (fy, month, vehicle_group);
create index if not exists md_quotes_customer on md_quotes (customer_id);

-- ── Prebuilt dashboard payload, one row per FY ──────────────────────────
create table if not exists md_workshop_map_cache (
  fy         integer primary key,
  payload    jsonb not null,
  run_id     uuid,
  synced_at  timestamptz not null default now()
);

-- ── Sync run log (surfaced on the dashboard as "last sync") ────────────
create table if not exists md_workshop_map_runs (
  id            uuid primary key default gen_random_uuid(),
  status        text not null default 'pending',   -- pending | running | done | error
  requested_by  text,
  invoice_count integer,
  quote_count   integer,
  error         text,
  meta          jsonb,                             -- geocode coverage, validation results, per-FY counts
  started_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index if not exists md_workshop_map_runs_started on md_workshop_map_runs (started_at desc);
