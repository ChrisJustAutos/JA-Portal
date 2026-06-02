-- 061_b2b_freight_satchels.sql
-- Flat-rate satchels (e.g. Australia Post prepaid satchels): a fixed freight
-- price anywhere in Australia, gated by total order weight. Offered alongside
-- MachShip carrier rates at quote time; the cart auto-picks the cheapest. Unlike
-- MachShip, satchel orders are NOT auto-booked — they ship manually (staff lodge
-- the prepaid satchel and enter tracking).
--
-- Prices are stored EX-GST (consistent with b2b_freight_rates / freight_cost_ex_gst);
-- the admin manager enters the GST-INCLUSIVE figure and converts on save.
--   sell_ex_gst — what the distributor is charged (before GST)
--   cost_ex_gst — what we pay the carrier (for freight-margin reporting)

create table if not exists b2b_freight_satchels (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  max_weight_g  integer not null,            -- order qualifies if total weight <= this
  max_length_mm integer,                     -- optional per-item size cap (null = weight-only)
  max_width_mm  integer,
  max_height_mm integer,
  cost_ex_gst   numeric(10,2) not null default 0,
  sell_ex_gst   numeric(10,2) not null default 0,
  sort_order    integer not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz default now()
);

-- Match b2b_freight_boxes: RLS on, no policies → service-role only (all access
-- goes through the admin API which uses the service-role key).
alter table b2b_freight_satchels enable row level security;

-- Record on the order which satchel was chosen (null for carrier/static freight).
alter table b2b_orders add column if not exists freight_satchel_id uuid references b2b_freight_satchels(id);
