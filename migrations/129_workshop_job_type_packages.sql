-- 129_workshop_job_type_packages.sql
-- "Packages" = a named, ordered bundle of existing job types (e.g. a
-- "Stage 1 Tune Package"). Applying a package drops each member job type's
-- block (description heading + its labour/parts) onto a quote OR a booking/
-- invoice in one click — a pre-set quote / pre-set invoice. Members reference
-- job types by id (single source of truth) rather than copying line data.

create table if not exists public.workshop_job_type_packages (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  active      boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.workshop_job_type_package_items (
  id          uuid primary key default gen_random_uuid(),
  package_id  uuid not null references public.workshop_job_type_packages(id) on delete cascade,
  job_type_id uuid not null references public.workshop_job_types(id) on delete cascade,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists workshop_job_type_package_items_pkg_idx
  on public.workshop_job_type_package_items (package_id, sort_order);

alter table public.workshop_job_type_packages       enable row level security;
alter table public.workshop_job_type_package_items  enable row level security;
