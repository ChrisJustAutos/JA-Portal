-- ═══════════════════════════════════════════════════════════════════
-- 059_b2b_catalogue_multi_model.sql
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd, then kept for reference.
--
-- A catalogue product can now fit MULTIPLE models (e.g. a billet pressure
-- relief valve fits both 200-series and 70-series). Adds a join table as the
-- source of truth for fitment; the existing single b2b_catalogue.model_id is
-- kept as a back-compat "primary model" (set to one of the linked models).
-- Backfills the join from the current model_id.
-- ═══════════════════════════════════════════════════════════════════

create table if not exists public.b2b_catalogue_models (
  catalogue_id uuid not null references public.b2b_catalogue(id) on delete cascade,
  model_id     uuid not null references public.b2b_models(id)    on delete cascade,
  primary key (catalogue_id, model_id)
);

create index if not exists b2b_catalogue_models_model_idx on public.b2b_catalogue_models(model_id);
create index if not exists b2b_catalogue_models_cat_idx   on public.b2b_catalogue_models(catalogue_id);

-- Backfill from the existing single-model column.
insert into public.b2b_catalogue_models (catalogue_id, model_id)
  select id, model_id from public.b2b_catalogue where model_id is not null
  on conflict do nothing;

-- RLS (the app reads via the service-role key, but keep it locked down anyway).
alter table public.b2b_catalogue_models enable row level security;

create policy "b2b_catalogue_models_distributor_read" on public.b2b_catalogue_models
  for select to authenticated
  using (public.b2b_current_distributor_id() is not null);

create policy "b2b_catalogue_models_staff_all" on public.b2b_catalogue_models
  for all to authenticated
  using (public.b2b_is_portal_staff())
  with check (public.b2b_is_portal_admin());
