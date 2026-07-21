-- 168: Product categories for the Parts:Tunes "Per part" lens — group parts
-- accounts into sellable categories (Airbox, Exhaust, Fan Kit, Cooling…) to
-- show units sold per tuned car per category. Account-code based so itemless
-- SUP special-order lines group too. Editable in Groups Admin.
-- (Seeded in prod 2026-07-22 with one category per parts account family:
-- Airbox 4-1401 / Exhaust 4-1602 / Snorkel 4-1701 / Fan Kit 4-1802 /
-- Cooling 4-1803 / Intake Pipe 4-1805,4-1813 / Filter Guard 4-1807 /
-- Turbo 4-1814 / Sump 4-1861 / Genuine Part 4-1821 / Misc 4-1000.)

create table if not exists dist_part_categories (
  id            bigserial primary key,
  name          text not null unique,
  sort_order    int  not null default 100,
  account_codes text[] not null default '{}',
  created_at    timestamptz not null default now()
);
alter table dist_part_categories enable row level security;
