-- 203_b2b_min_order_qty.sql
--
-- Minimum order quantity per catalogue item.
--
-- The mirror of the existing max_order_qty (migration 125): some items are only
-- sold in a sensible minimum — a carton of filters, a set of four, a length of
-- hose nobody wants one metre of — and until now a distributor could add one of
-- anything.
--
-- NULL means no minimum, which reads the same as 1. Stored as NULL rather than
-- defaulted to 1 so "no minimum set" and "minimum is deliberately 1" stay
-- distinguishable in the admin screen, and so the column costs nothing on the
-- rows that don't use it.
--
-- The check allows values >= 1 only. A minimum of 0 would mean nothing, and a
-- negative one would silently disable the qty guard in the cart API.
--
-- Safe to re-run.

begin;

alter table b2b_catalogue
  add column if not exists min_order_qty integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'b2b_catalogue_min_order_qty_positive'
  ) then
    alter table b2b_catalogue
      add constraint b2b_catalogue_min_order_qty_positive
      check (min_order_qty is null or min_order_qty >= 1);
  end if;
end $$;

-- A minimum above a maximum would make the item unorderable: the cart would
-- reject every quantity, with two different messages depending on which guard
-- ran first. Refuse the combination at the database rather than debugging it
-- from a distributor's phone call.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'b2b_catalogue_min_not_above_max'
  ) then
    alter table b2b_catalogue
      add constraint b2b_catalogue_min_not_above_max
      check (min_order_qty is null or max_order_qty is null or min_order_qty <= max_order_qty);
  end if;
end $$;

comment on column b2b_catalogue.min_order_qty is
  'Minimum quantity a distributor may order of this item. NULL = no minimum '
  '(same as 1). Enforced in pages/api/b2b/cart/items.ts and at checkout; the '
  'catalogue tile and cart stepper start and floor at this value (migration 203).';

commit;
