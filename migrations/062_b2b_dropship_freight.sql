-- 062_b2b_dropship_freight.sql
-- Per-product, per-zone freight for DROP-SHIP items. A drop-ship product (e.g. an
-- MPI exhaust) ships direct from the supplier, not our warehouse — so it's excluded
-- from the MachShip/satchel quote and instead carries its own freight price that
-- reflects what the supplier charges to ship it. Priced by destination using the
-- existing b2b_freight_zones (reused, not duplicated). Single figure billed to the
-- customer (stored ex-GST like all other freight; GST added at checkout).

create table if not exists b2b_dropship_freight_rates (
  catalogue_id uuid not null references b2b_catalogue(id) on delete cascade,
  zone_id      uuid not null references b2b_freight_zones(id) on delete cascade,
  price_ex_gst numeric(10,2) not null default 0,
  updated_at   timestamptz default now(),
  primary key (catalogue_id, zone_id)
);

-- Service-role only, mirroring the other freight config tables (RLS on, no policies).
alter table b2b_dropship_freight_rates enable row level security;

-- Breakdown stored on the order; the customer-facing freight total in
-- b2b_orders.freight_cost_ex_gst already INCLUDES this amount.
alter table b2b_orders add column if not exists dropship_freight_ex_gst numeric(10,2);
