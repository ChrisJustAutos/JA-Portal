-- 169: B2B distributor resource library ("Assets"): sectioned documents
-- (Quote Page / Package Information / Technical / Operation Instructions /
-- Bulletins / Training Document / Media Assets) uploaded by admins, browsed +
-- downloaded by distributors, with bell notifications on add/update.
-- Applied to prod 2026-07-22.

create table if not exists b2b_assets (
  id            uuid primary key default gen_random_uuid(),
  section       text not null,
  title         text not null,
  description   text,
  storage_path  text not null,
  file_name     text not null,
  mime          text,
  size_bytes    bigint,
  sort_order    int not null default 100,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    text
);
create index if not exists idx_b2b_assets_section on b2b_assets (section, sort_order);
alter table b2b_assets enable row level security;
-- No policies: service-role APIs only.

-- Private storage bucket for the files (signed URLs only).
insert into storage.buckets (id, name, public)
values ('b2b-assets', 'b2b-assets', false)
on conflict (id) do nothing;
