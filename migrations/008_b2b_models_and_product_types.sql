-- Drop the unused categories taxonomy (0 rows, no products categorised) and
-- replace with two independent lookup tables: models and product_types.
-- Catalogue items can be tagged with one of each, used to group products on
-- the distributor catalogue page.
--
-- Applied to Supabase project qtiscbvhlvdvafwtdtcd via apply_migration on
-- 2026-05-07. This file is the tracked copy.

alter table public.b2b_catalogue drop column if exists category_id;
drop table if exists public.b2b_categories cascade;

-- ─── Models (e.g. vehicle model: "Ranger PX MkII", "Hilux N80") ─────────
create table public.b2b_models (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─── Product types (e.g. "Brake disc", "CV axle") ───────────────────────
create table public.b2b_product_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─── Catalogue references ───────────────────────────────────────────────
alter table public.b2b_catalogue
  add column if not exists model_id uuid references public.b2b_models(id) on delete set null,
  add column if not exists product_type_id uuid references public.b2b_product_types(id) on delete set null;

create index if not exists b2b_catalogue_model_id_idx on public.b2b_catalogue(model_id);
create index if not exists b2b_catalogue_product_type_id_idx on public.b2b_catalogue(product_type_id);

-- ─── RLS ────────────────────────────────────────────────────────────────
alter table public.b2b_models        enable row level security;
alter table public.b2b_product_types enable row level security;

create policy "b2b_models_distributor_read_active" on public.b2b_models
  for select to authenticated
  using (is_active = true and public.b2b_current_distributor_id() is not null);

create policy "b2b_models_staff_all" on public.b2b_models
  for all to authenticated
  using (public.b2b_is_portal_staff())
  with check (public.b2b_is_portal_admin());

create policy "b2b_product_types_distributor_read_active" on public.b2b_product_types
  for select to authenticated
  using (is_active = true and public.b2b_current_distributor_id() is not null);

create policy "b2b_product_types_staff_all" on public.b2b_product_types
  for all to authenticated
  using (public.b2b_is_portal_staff())
  with check (public.b2b_is_portal_admin());

-- ─── updated_at triggers ────────────────────────────────────────────────
create trigger b2b_models_updated_at        before update on public.b2b_models
  for each row execute function public.b2b_set_updated_at();
create trigger b2b_product_types_updated_at before update on public.b2b_product_types
  for each row execute function public.b2b_set_updated_at();
