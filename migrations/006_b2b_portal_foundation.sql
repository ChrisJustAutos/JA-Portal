-- =========================================================================
-- Migration: B2B Portal — Foundation
-- =========================================================================
-- Creates the foundation tables, RLS policies, storage bucket, and helper
-- functions for the JAWS B2B distributor portal.
--
-- Distributors place orders for stocked items, pay via Stripe (with surcharge
-- passed through), orders write back to MYOB JAWS as sale invoices.
--
-- Conventions:
--   * All B2B tables prefixed with b2b_
--   * RLS enabled on every table
--   * Distributor users see their own data only; portal staff see everything
--   * Catalogue is uniformly priced — single trade price per SKU, not
--     per-distributor
--   * MYOB writeback targets JAWS company file only
--
-- Suggested filename in repo:
--   supabase/migrations/20260506000001_b2b_portal_foundation.sql
-- =========================================================================


-- ─── Helper functions ────────────────────────────────────────────────────

create or replace function public.b2b_is_portal_staff()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists(
    select 1 from public.user_profiles
    where id = auth.uid() and is_active = true
  )
$$;

create or replace function public.b2b_is_portal_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists(
    select 1 from public.user_profiles
    where id = auth.uid() and is_active = true and role in ('admin','manager')
  )
$$;

-- Returns the distributor_id for the currently authenticated B2B user.
-- Returns null for staff users (or unauthenticated requests).
create or replace function public.b2b_current_distributor_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select distributor_id from public.b2b_distributor_users
  where auth_user_id = auth.uid() and is_active = true
  limit 1
$$;

-- Generic updated_at trigger
create or replace function public.b2b_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ─── b2b_distributors ────────────────────────────────────────────────────
-- One row per distributor account (the entity that logs in).

create table public.b2b_distributors (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  trading_name text,
  abn text,

  -- MYOB linkage (JAWS-only for now)
  myob_company_file text not null default 'JAWS' check (myob_company_file = 'JAWS'),
  myob_primary_customer_uid text not null,            -- new orders write here
  myob_primary_customer_display_id text,              -- denormalised customer code
  myob_linked_customer_uids text[] not null default '{}',  -- e.g. Tuning card, for combined-history viewing

  -- Existing dist_groups linkage (powers /distributors page)
  dist_group_id integer references public.dist_groups(id) on delete set null,

  -- Contact
  primary_contact_email text,
  primary_contact_phone text,
  notes text,
  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index b2b_distributors_active_idx on public.b2b_distributors(is_active) where is_active = true;
create index b2b_distributors_myob_uid_idx on public.b2b_distributors(myob_primary_customer_uid);
comment on table public.b2b_distributors is
  'B2B portal distributor accounts. One row per distributor. Multiple users can sign in under one distributor.';


-- ─── b2b_distributor_users ───────────────────────────────────────────────
-- Login accounts. auth_user_id is null until first magic-link sign-in.

create table public.b2b_distributor_users (
  id uuid primary key default gen_random_uuid(),
  distributor_id uuid not null references public.b2b_distributors(id) on delete cascade,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  email text not null,
  full_name text,
  role text not null default 'member' check (role in ('owner','member')),
  is_active boolean not null default true,
  invited_at timestamptz,
  invited_by uuid references auth.users(id),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index b2b_distributor_users_email_lower_idx on public.b2b_distributor_users (lower(email));
create index b2b_distributor_users_distributor_idx on public.b2b_distributor_users(distributor_id);
create index b2b_distributor_users_auth_idx on public.b2b_distributor_users(auth_user_id);
comment on table public.b2b_distributor_users is
  'Login accounts for the B2B portal. auth_user_id is null until first magic-link sign-in.';


-- ─── b2b_categories ──────────────────────────────────────────────────────

create table public.b2b_categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.b2b_categories is
  'Catalogue navigation categories (e.g. Tuning, Hard Parts, Oil).';


-- ─── b2b_catalogue ───────────────────────────────────────────────────────
-- Mirrors selected MYOB Items + B2B-only metadata. Trade price stored here.

create table public.b2b_catalogue (
  id uuid primary key default gen_random_uuid(),

  -- MYOB linkage
  myob_company_file text not null default 'JAWS' check (myob_company_file = 'JAWS'),
  myob_item_uid text unique,                          -- nullable so we can stage new items
  sku text not null,                                  -- mirrored for fast search

  -- Display
  name text not null,
  description text,
  category_id uuid references public.b2b_categories(id) on delete set null,

  -- Pricing (uniform across all distributors)
  trade_price_ex_gst numeric(10,2) not null check (trade_price_ex_gst >= 0),
  rrp_ex_gst numeric(10,2) check (rrp_ex_gst >= 0),
  is_taxable boolean not null default true,           -- maps to MYOB tax code on writeback

  -- Display config
  primary_image_url text,                             -- denormalised for fast list rendering
  spec_sheet_url text,                                -- optional PDF link
  b2b_visible boolean not null default false,         -- admin flicks on per item

  -- MYOB sync metadata
  last_synced_from_myob_at timestamptz,
  myob_snapshot jsonb,                                -- last raw item payload from MYOB

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index b2b_catalogue_visible_idx on public.b2b_catalogue(b2b_visible) where b2b_visible = true;
create index b2b_catalogue_category_idx on public.b2b_catalogue(category_id);
create index b2b_catalogue_sku_idx on public.b2b_catalogue (lower(sku));
comment on table public.b2b_catalogue is
  'B2B catalogue. Mirrors selected MYOB Items + B2B-only fields (description, images, visibility, trade price).';


-- ─── b2b_catalogue_images ────────────────────────────────────────────────

create table public.b2b_catalogue_images (
  id uuid primary key default gen_random_uuid(),
  catalogue_id uuid not null references public.b2b_catalogue(id) on delete cascade,
  storage_path text not null,                         -- path within b2b-catalogue bucket
  url text not null,                                  -- public URL (bucket is public)
  alt_text text,
  sort_order integer not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index b2b_catalogue_images_catalogue_idx on public.b2b_catalogue_images(catalogue_id, sort_order);
create unique index b2b_catalogue_images_primary_uniq
  on public.b2b_catalogue_images(catalogue_id) where is_primary = true;


-- ─── b2b_shipping_addresses ──────────────────────────────────────────────

create table public.b2b_shipping_addresses (
  id uuid primary key default gen_random_uuid(),
  distributor_id uuid not null references public.b2b_distributors(id) on delete cascade,
  label text not null,                                -- "Main warehouse", "Sydney site"
  recipient_name text,
  attention text,
  street_line_1 text not null,
  street_line_2 text,
  suburb text not null,
  state text not null,
  postcode text not null,
  country text not null default 'AU',
  phone text,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index b2b_shipping_addresses_distributor_idx on public.b2b_shipping_addresses(distributor_id);
create unique index b2b_shipping_addresses_default_per_distributor
  on public.b2b_shipping_addresses(distributor_id) where is_default = true and is_active = true;


-- ─── b2b_carts / b2b_cart_items ──────────────────────────────────────────
-- One cart per distributor user. Persists across sessions.

create table public.b2b_carts (
  id uuid primary key default gen_random_uuid(),
  distributor_user_id uuid not null unique references public.b2b_distributor_users(id) on delete cascade,
  distributor_id uuid not null references public.b2b_distributors(id) on delete cascade,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index b2b_carts_distributor_idx on public.b2b_carts(distributor_id);

create table public.b2b_cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.b2b_carts(id) on delete cascade,
  catalogue_id uuid not null references public.b2b_catalogue(id) on delete cascade,
  qty integer not null check (qty > 0),
  -- Snapshot at add-time so we can revalidate at checkout if pricing changed
  trade_price_ex_gst_at_add numeric(10,2) not null,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cart_id, catalogue_id)
);
create index b2b_cart_items_cart_idx on public.b2b_cart_items(cart_id);


-- ─── Order-number sequence ───────────────────────────────────────────────

create sequence if not exists public.b2b_order_seq start with 1;

create or replace function public.b2b_next_order_number()
returns text
language sql
as $$
  select 'B2B-'
    || to_char(now() at time zone 'Australia/Brisbane', 'YYYY')
    || '-'
    || lpad(nextval('public.b2b_order_seq')::text, 6, '0')
$$;


-- ─── b2b_orders ──────────────────────────────────────────────────────────

create table public.b2b_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique default public.b2b_next_order_number(),

  distributor_id uuid not null references public.b2b_distributors(id),
  placed_by_user_id uuid references public.b2b_distributor_users(id) on delete set null,
  shipping_address_id uuid references public.b2b_shipping_addresses(id) on delete set null,
  shipping_address_snapshot jsonb,                     -- locked at order time

  status text not null default 'pending_payment' check (
    status in ('pending_payment','paid','picking','packed','shipped','delivered','cancelled','refunded')
  ),

  -- Money (all AUD)
  subtotal_ex_gst numeric(10,2) not null,
  gst numeric(10,2) not null default 0,
  card_fee_inc numeric(10,2) not null default 0,      -- Stripe surcharge gross-up
  total_inc numeric(10,2) not null,                    -- amount Stripe charged
  currency text not null default 'AUD',

  -- Stripe
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  stripe_charge_id text,
  paid_at timestamptz,

  -- MYOB writeback
  myob_company_file text not null default 'JAWS' check (myob_company_file = 'JAWS'),
  myob_invoice_uid text,
  myob_invoice_number text,
  myob_invoice_row_id integer,
  myob_written_at timestamptz,
  myob_write_attempts integer not null default 0,
  myob_write_error text,

  -- Fulfilment
  carrier text,
  tracking_number text,
  picked_at timestamptz,
  packed_at timestamptz,
  shipped_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  refunded_at timestamptz,

  -- Notes
  customer_notes text,
  internal_notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index b2b_orders_distributor_created_idx on public.b2b_orders(distributor_id, created_at desc);
create index b2b_orders_status_open_idx on public.b2b_orders(status) where status not in ('delivered','cancelled','refunded');
create index b2b_orders_stripe_pi_idx on public.b2b_orders(stripe_payment_intent_id);
create index b2b_orders_stripe_session_idx on public.b2b_orders(stripe_checkout_session_id);
create index b2b_orders_created_idx on public.b2b_orders(created_at desc);


-- ─── b2b_order_lines ─────────────────────────────────────────────────────

create table public.b2b_order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.b2b_orders(id) on delete cascade,
  catalogue_id uuid references public.b2b_catalogue(id) on delete set null,

  -- Snapshot at order time (catalogue could be edited later)
  myob_item_uid text not null,
  sku text not null,
  name text not null,
  qty integer not null check (qty > 0),
  unit_trade_price_ex_gst numeric(10,2) not null,
  line_subtotal_ex_gst numeric(10,2) not null,
  line_gst numeric(10,2) not null default 0,
  line_total_inc numeric(10,2) not null,
  is_taxable boolean not null default true,
  sort_order integer not null default 0,

  -- MYOB writeback metadata
  myob_invoice_line_id text,

  created_at timestamptz not null default now()
);
create index b2b_order_lines_order_idx on public.b2b_order_lines(order_id, sort_order);


-- ─── b2b_order_events ────────────────────────────────────────────────────

create table public.b2b_order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.b2b_orders(id) on delete cascade,
  event_type text not null,
  from_status text,
  to_status text,
  actor_type text check (actor_type in ('distributor_user','portal_staff','system','stripe','myob')),
  actor_id uuid,
  notes text,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index b2b_order_events_order_idx on public.b2b_order_events(order_id, created_at desc);
comment on table public.b2b_order_events is 'Append-only audit log of order lifecycle events.';


-- ─── b2b_settings (singleton) ────────────────────────────────────────────

create table public.b2b_settings (
  id text primary key default 'singleton' check (id = 'singleton'),

  -- Stripe
  stripe_publishable_key text,
  stripe_webhook_secret_hint text,                    -- last 4 chars only, for display
  card_fee_percent numeric(6,4) not null default 0.0170,    -- 1.70% (verify your contract rate)
  card_fee_fixed numeric(10,2) not null default 0.30,

  -- MYOB writeback config
  myob_company_file text not null default 'JAWS' check (myob_company_file = 'JAWS'),
  myob_jaws_gst_tax_code_uid text,                    -- copy of ap_settings.gst_tax_code_uid_jaws
  myob_jaws_fre_tax_code_uid text,
  myob_card_fee_account_uid text,                     -- 4-xxxx Card Processing Fees Recovered
  myob_card_fee_account_code text,
  myob_default_freight_account_uid text,              -- placeholder for later

  -- Notifications
  slack_new_order_webhook_url text,

  -- Catalogue sync
  last_catalogue_sync_at timestamptz,
  last_catalogue_sync_added integer,
  last_catalogue_sync_updated integer,
  last_catalogue_sync_error text,

  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
insert into public.b2b_settings (id) values ('singleton') on conflict do nothing;


-- ─── RLS ─────────────────────────────────────────────────────────────────

alter table public.b2b_distributors          enable row level security;
alter table public.b2b_distributor_users     enable row level security;
alter table public.b2b_categories            enable row level security;
alter table public.b2b_catalogue             enable row level security;
alter table public.b2b_catalogue_images      enable row level security;
alter table public.b2b_shipping_addresses    enable row level security;
alter table public.b2b_carts                 enable row level security;
alter table public.b2b_cart_items            enable row level security;
alter table public.b2b_orders                enable row level security;
alter table public.b2b_order_lines           enable row level security;
alter table public.b2b_order_events          enable row level security;
alter table public.b2b_settings              enable row level security;


-- b2b_distributors
create policy "b2b_distributors_staff_all" on public.b2b_distributors
  for all to authenticated
  using (public.b2b_is_portal_staff())
  with check (public.b2b_is_portal_admin());
create policy "b2b_distributors_distributor_read_own" on public.b2b_distributors
  for select to authenticated
  using (id = public.b2b_current_distributor_id());

-- b2b_distributor_users
create policy "b2b_distributor_users_staff_all" on public.b2b_distributor_users
  for all to authenticated
  using (public.b2b_is_portal_staff())
  with check (public.b2b_is_portal_admin());
create policy "b2b_distributor_users_distributor_read_own" on public.b2b_distributor_users
  for select to authenticated
  using (distributor_id = public.b2b_current_distributor_id());

-- b2b_categories
create policy "b2b_categories_staff_all" on public.b2b_categories
  for all to authenticated
  using (public.b2b_is_portal_staff())
  with check (public.b2b_is_portal_admin());
create policy "b2b_categories_distributor_read_active" on public.b2b_categories
  for select to authenticated
  using (is_active = true and public.b2b_current_distributor_id() is not null);

-- b2b_catalogue
create policy "b2b_catalogue_staff_all" on public.b2b_catalogue
  for all to authenticated
  using (public.b2b_is_portal_staff())
  with check (public.b2b_is_portal_admin());
create policy "b2b_catalogue_distributor_read_visible" on public.b2b_catalogue
  for select to authenticated
  using (b2b_visible = true and public.b2b_current_distributor_id() is not null);

-- b2b_catalogue_images
create policy "b2b_catalogue_images_staff_all" on public.b2b_catalogue_images
  for all to authenticated
  using (public.b2b_is_portal_staff())
  with check (public.b2b_is_portal_admin());
create policy "b2b_catalogue_images_distributor_read_visible" on public.b2b_catalogue_images
  for select to authenticated
  using (
    public.b2b_current_distributor_id() is not null
    and exists (
      select 1 from public.b2b_catalogue c
      where c.id = catalogue_id and c.b2b_visible = true
    )
  );

-- b2b_shipping_addresses
create policy "b2b_shipping_addresses_staff_all" on public.b2b_shipping_addresses
  for all to authenticated
  using (public.b2b_is_portal_staff())
  with check (public.b2b_is_portal_admin());
create policy "b2b_shipping_addresses_distributor_read_own" on public.b2b_shipping_addresses
  for select to authenticated
  using (distributor_id = public.b2b_current_distributor_id());
create policy "b2b_shipping_addresses_distributor_insert_own" on public.b2b_shipping_addresses
  for insert to authenticated
  with check (distributor_id = public.b2b_current_distributor_id());
create policy "b2b_shipping_addresses_distributor_update_own" on public.b2b_shipping_addresses
  for update to authenticated
  using (distributor_id = public.b2b_current_distributor_id())
  with check (distributor_id = public.b2b_current_distributor_id());

-- b2b_carts
create policy "b2b_carts_staff_read" on public.b2b_carts
  for select to authenticated
  using (public.b2b_is_portal_staff());
create policy "b2b_carts_user_manage_own" on public.b2b_carts
  for all to authenticated
  using (
    distributor_user_id in (
      select id from public.b2b_distributor_users
      where auth_user_id = auth.uid() and is_active = true
    )
  )
  with check (
    distributor_user_id in (
      select id from public.b2b_distributor_users
      where auth_user_id = auth.uid() and is_active = true
    )
  );

-- b2b_cart_items
create policy "b2b_cart_items_staff_read" on public.b2b_cart_items
  for select to authenticated
  using (public.b2b_is_portal_staff());
create policy "b2b_cart_items_user_manage_own" on public.b2b_cart_items
  for all to authenticated
  using (
    cart_id in (
      select c.id from public.b2b_carts c
      join public.b2b_distributor_users u on u.id = c.distributor_user_id
      where u.auth_user_id = auth.uid() and u.is_active = true
    )
  )
  with check (
    cart_id in (
      select c.id from public.b2b_carts c
      join public.b2b_distributor_users u on u.id = c.distributor_user_id
      where u.auth_user_id = auth.uid() and u.is_active = true
    )
  );

-- b2b_orders
-- (Inserts and status transitions happen via API routes using service-role
--  key, so distributor-write policies are intentionally absent.)
create policy "b2b_orders_staff_all" on public.b2b_orders
  for all to authenticated
  using (public.b2b_is_portal_staff())
  with check (public.b2b_is_portal_admin());
create policy "b2b_orders_distributor_read_own" on public.b2b_orders
  for select to authenticated
  using (distributor_id = public.b2b_current_distributor_id());

-- b2b_order_lines
create policy "b2b_order_lines_staff_all" on public.b2b_order_lines
  for all to authenticated
  using (public.b2b_is_portal_staff())
  with check (public.b2b_is_portal_admin());
create policy "b2b_order_lines_distributor_read_own" on public.b2b_order_lines
  for select to authenticated
  using (
    order_id in (
      select id from public.b2b_orders
      where distributor_id = public.b2b_current_distributor_id()
    )
  );

-- b2b_order_events
create policy "b2b_order_events_staff_all" on public.b2b_order_events
  for all to authenticated
  using (public.b2b_is_portal_staff())
  with check (public.b2b_is_portal_admin());
create policy "b2b_order_events_distributor_read_own" on public.b2b_order_events
  for select to authenticated
  using (
    order_id in (
      select id from public.b2b_orders
      where distributor_id = public.b2b_current_distributor_id()
    )
  );

-- b2b_settings (staff-only)
create policy "b2b_settings_staff_read" on public.b2b_settings
  for select to authenticated
  using (public.b2b_is_portal_staff());
create policy "b2b_settings_admin_update" on public.b2b_settings
  for update to authenticated
  using (public.b2b_is_portal_admin())
  with check (public.b2b_is_portal_admin());


-- ─── Updated_at triggers ─────────────────────────────────────────────────

create trigger b2b_distributors_updated_at         before update on public.b2b_distributors         for each row execute function public.b2b_set_updated_at();
create trigger b2b_distributor_users_updated_at    before update on public.b2b_distributor_users    for each row execute function public.b2b_set_updated_at();
create trigger b2b_categories_updated_at           before update on public.b2b_categories           for each row execute function public.b2b_set_updated_at();
create trigger b2b_catalogue_updated_at            before update on public.b2b_catalogue            for each row execute function public.b2b_set_updated_at();
create trigger b2b_shipping_addresses_updated_at   before update on public.b2b_shipping_addresses   for each row execute function public.b2b_set_updated_at();
create trigger b2b_carts_updated_at                before update on public.b2b_carts                for each row execute function public.b2b_set_updated_at();
create trigger b2b_cart_items_updated_at           before update on public.b2b_cart_items           for each row execute function public.b2b_set_updated_at();
create trigger b2b_orders_updated_at               before update on public.b2b_orders               for each row execute function public.b2b_set_updated_at();
create trigger b2b_settings_updated_at             before update on public.b2b_settings             for each row execute function public.b2b_set_updated_at();


-- ─── Storage bucket: b2b-catalogue ───────────────────────────────────────
-- Public bucket so PDP/list pages can render images via direct URL without
-- signing. Path scheme: catalogue_id/{nanoid}.{ext}

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'b2b-catalogue',
  'b2b-catalogue',
  true,
  10 * 1024 * 1024,                         -- 10 MB per file
  array['image/jpeg','image/png','image/webp','image/gif','application/pdf']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Storage policies
do $$
begin
  -- Drop existing policies on this bucket if re-running
  drop policy if exists "b2b_catalogue_storage_staff_write" on storage.objects;
  drop policy if exists "b2b_catalogue_storage_authenticated_read" on storage.objects;
exception when others then null;
end $$;

create policy "b2b_catalogue_storage_staff_write" on storage.objects
  for all to authenticated
  using (bucket_id = 'b2b-catalogue' and public.b2b_is_portal_admin())
  with check (bucket_id = 'b2b-catalogue' and public.b2b_is_portal_admin());

-- Bucket is public, so anonymous reads work via direct URL.
-- This explicit policy is for client SDK reads (signed-URL flows).
create policy "b2b_catalogue_storage_authenticated_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'b2b-catalogue');


-- ─── Done ────────────────────────────────────────────────────────────────
