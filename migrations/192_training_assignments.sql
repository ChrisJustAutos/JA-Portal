-- 192: training assignments.
--
-- Chris (2026-08-07): training returns as ASSIGNED coursework — admin assigns
-- per distributor or per individual user; distributors only see assigned
-- modules. A row with distributor_user_id NULL assigns the module to the
-- WHOLE distributor (every current + future portal user); a non-null
-- distributor_user_id assigns it to that one membership row only (a "user"
-- here = a b2b_distributor_users row, which is already distributor-scoped —
-- multi-site people have one row per distributor).

create table if not exists b2b_training_assignments (
  id uuid primary key default gen_random_uuid(),
  module_id uuid not null references b2b_training_modules(id) on delete cascade,
  distributor_id uuid not null references b2b_distributors(id) on delete cascade,
  -- null = assigned to the whole distributor; non-null = that one membership
  distributor_user_id uuid references b2b_distributor_users(id) on delete cascade,
  created_by uuid,
  created_at timestamptz not null default now()
);

-- One whole-distributor row per (module, distributor)…
create unique index if not exists b2b_training_assignments_dist_uq
  on b2b_training_assignments (module_id, distributor_id)
  where distributor_user_id is null;
-- …and one per-user row per (module, membership).
create unique index if not exists b2b_training_assignments_user_uq
  on b2b_training_assignments (module_id, distributor_user_id)
  where distributor_user_id is not null;

create index if not exists b2b_training_assignments_distributor_idx
  on b2b_training_assignments (distributor_id);

-- Service-role access only (all reads/writes go through the portal API).
alter table b2b_training_assignments enable row level security;

-- Re-enable the modules that were switched off when training was hidden
-- globally (2026-08-06). Safe: with zero assignment rows nobody sees them —
-- visibility is assignment-gated from this migration on.
update b2b_training_modules set enabled = true where slug in ('ja101','ja102');
