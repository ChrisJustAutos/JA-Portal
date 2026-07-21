-- 166: Description keyword -> vehicle-model rules for the Parts:Tunes view.
-- Fallback for parts lines with NO MYOB item (special-order "SUP -" lines,
-- deleted one-off items): case-insensitive substring match on the line
-- description, first match by sort_order wins. Editable in Groups Admin ->
-- Item -> Vehicle. Model names = the VIN-rule buckets.
-- (Seed rules applied in prod 2026-07-21: VDJ200/LC200 -> LC200; VDJ7x/
-- 7x SERIES -> VDJ70 Series; GDJ7 -> GDJ70 Series; FJA300/LC300/300 SERIES
-- -> LC300; GDJ250/PRADO 250 -> Prado 250; 1GD/N80/GUN126 -> Hilux N80;
-- KUN126/KUN26 -> KUN126R.)

create table if not exists dist_desc_model_rules (
  id          bigserial primary key,
  keyword     text not null unique,
  model       text not null,
  sort_order  int  not null default 100,
  created_at  timestamptz not null default now()
);
alter table dist_desc_model_rules enable row level security;
