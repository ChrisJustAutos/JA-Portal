-- 165: Parts-item -> vehicle-model tick map for the Distributors report
-- Parts:Tunes view. (Applied to prod as two migrations,
-- distributor_vehicle_types + distributor_item_model_map — the first
-- created FK-based vehicle-type tables that were dropped by the second
-- before any use. Net effect is this file.)
--
-- Vehicle buckets are the VIN-derived model names (vin_model_codes
-- friendly_name/model_code) so the tunes side (VIN -> model, already live
-- on the Distributor Sales tab) and the parts side share buckets with no
-- second mapping layer. An item ticked for N models contributes 1/N of its
-- quantity/revenue to each (Chris 2026-07-21: split evenly).

create table if not exists dist_item_model_map (
  id           bigserial primary key,
  item_number  text not null,
  item_name    text,
  model        text not null,
  created_at   timestamptz not null default now(),
  unique (item_number, model)
);
create index if not exists idx_dist_item_model_map_item on dist_item_model_map (item_number);

alter table dist_item_model_map enable row level security;
