-- 124_b2b_product_bundles.sql
-- "Includes" bundles for the B2B catalogue.
--
-- A parent product automatically includes one or more child products that
-- ship in the same box and (usually) aren't sold separately — e.g. every
-- JA turbo includes a TGFK gasket/fitting kit.
--
-- Design: children are NOT materialised as cart lines. They're DERIVED from
-- this table wherever a cart/order is built (display, totals, checkout
-- order-lines, MYOB push). This keeps freight correct — the PARENT carries
-- the combined-carton dimensions (set freight_packaging = 'other' / "already
-- boxed" on the turbo) and children are simply never fed to the cartonizer —
-- and avoids the (cart_id, catalogue_id) unique collision that would occur if
-- a child were ALSO bought on its own.
--
-- price_mode:
--   'included' — child value is baked into the parent's price; the child
--                order line posts at $0 (still decrements MYOB stock).
--   'added'    — child is charged on top at its own trade price.

create table if not exists public.b2b_product_bundles (
  id uuid primary key default gen_random_uuid(),
  parent_catalogue_id uuid not null references public.b2b_catalogue(id) on delete cascade,
  child_catalogue_id  uuid not null references public.b2b_catalogue(id) on delete cascade,
  qty integer not null default 1 check (qty > 0),
  price_mode text not null default 'included' check (price_mode in ('included', 'added')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (parent_catalogue_id, child_catalogue_id),
  check (parent_catalogue_id <> child_catalogue_id)
);

create index if not exists b2b_product_bundles_parent_idx
  on public.b2b_product_bundles(parent_catalogue_id);
create index if not exists b2b_product_bundles_child_idx
  on public.b2b_product_bundles(child_catalogue_id);

-- Mark an order line that was auto-added as a component of a parent line.
-- Null = a normal (parent or standalone) line. Used to (a) render components
-- as "included" on the order/invoice, and (b) EXCLUDE them from the freight
-- parcel build (their box is the parent's). SET NULL on parent delete so order
-- history survives a catalogue cleanup.
alter table public.b2b_order_lines
  add column if not exists bundle_parent_catalogue_id uuid
    references public.b2b_catalogue(id) on delete set null;
