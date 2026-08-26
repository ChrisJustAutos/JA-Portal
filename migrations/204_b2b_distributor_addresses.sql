-- 204_b2b_distributor_addresses.sql
--
-- Multiple ship-to addresses per distributor.
--
-- Some distributors run several stores under ONE entity — same ABN, same bank
-- account, same MYOB customer card, same trade pricing — they just want the
-- goods sent to whichever branch ordered them. Until now `b2b_distributors`
-- carried a single ship_* address, so a second store meant either a second
-- distributor account (splitting their pricing, credit and order history) or
-- ringing up to redirect the parcel.
--
-- Deliberately NOT a second distributor: the entity is the customer. This is
-- one customer with several delivery points.
--
-- The ship_* columns on b2b_distributors are LEFT IN PLACE and still act as the
-- fallback for anything that predates this. Every consumer already prefers
-- b2b_orders.shipping_address_snapshot and only falls back to the distributor
-- (freight booking, MYOB invoice ShipToAddress, the invoice PDF, drop-ship POs),
-- so filling that snapshot at checkout is all those paths need.
--
-- Safe to re-run.

begin;

create table if not exists b2b_distributor_addresses (
  id              uuid primary key default gen_random_uuid(),
  distributor_id  uuid not null references b2b_distributors(id) on delete cascade,
  -- What the distributor calls this place: "Penrith", "Head office", "Warehouse".
  -- Shown in the checkout dropdown, so it has to mean something to them.
  label           text not null,
  line1           text,
  line2           text,
  suburb          text,
  state           text,
  postcode        text,
  country         text default 'Australia',
  -- Contact at THIS site — the carrier rings this number, not head office.
  contact_name    text,
  contact_phone   text,
  -- Exactly one default per distributor (partial unique index below).
  is_default      boolean not null default false,
  is_active       boolean not null default true,
  sort_order      integer not null default 100,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists b2b_distributor_addresses_dist_idx
  on b2b_distributor_addresses (distributor_id, is_active, sort_order);

-- One default per distributor, enforced rather than hoped for: two defaults
-- would make "which address did this order use" ambiguous after the fact.
create unique index if not exists b2b_distributor_addresses_one_default
  on b2b_distributor_addresses (distributor_id) where is_default;

-- A postcode is what freight is priced on, so an active address without one
-- would silently produce a quote for the wrong place.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'b2b_distributor_addresses_active_needs_postcode') then
    alter table b2b_distributor_addresses
      add constraint b2b_distributor_addresses_active_needs_postcode
      check (is_active = false or (postcode is not null and btrim(postcode) <> ''));
  end if;
end $$;

-- Backfill: every distributor's existing ship_* address becomes its default,
-- so nothing changes for anyone until a second address is added.
insert into b2b_distributor_addresses
  (distributor_id, label, line1, line2, suburb, state, postcode, country, is_default, sort_order)
select d.id,
       coalesce(nullif(btrim(d.ship_suburb), ''), 'Main address'),
       d.ship_line1, d.ship_line2, d.ship_suburb, d.ship_state, d.ship_postcode,
       coalesce(nullif(btrim(d.ship_country), ''), 'Australia'),
       true, 10
from b2b_distributors d
where coalesce(btrim(d.ship_postcode), '') <> ''
  and not exists (select 1 from b2b_distributor_addresses a where a.distributor_id = d.id);

-- The cart remembers which site it is going to, so the freight quote on screen
-- is for that site and checkout can snapshot it onto the order.
-- ON DELETE SET NULL, not CASCADE: removing an address must never delete a cart.
alter table b2b_carts
  add column if not exists ship_address_id uuid references b2b_distributor_addresses(id) on delete set null;

-- Which address an order was actually sent to, alongside the existing
-- shipping_address_snapshot (which stays the authority — an address edited or
-- deleted later must not rewrite history on a shipped order).
alter table b2b_orders
  add column if not exists ship_address_id uuid references b2b_distributor_addresses(id) on delete set null;

comment on table b2b_distributor_addresses is
  'Ship-to addresses for a distributor. One entity, several delivery points '
  '(migration 204). The distributor ship_* columns remain the fallback.';
comment on column b2b_orders.ship_address_id is
  'Which address was chosen at checkout. shipping_address_snapshot is the '
  'authority for what was actually printed — this is only the link back.';

commit;
