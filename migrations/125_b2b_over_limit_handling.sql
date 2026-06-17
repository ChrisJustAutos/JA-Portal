-- 125_b2b_over_limit_handling.sql
-- Per-item "large order" handling for the B2B catalogue.
--
-- Each product can carry a SOFT threshold (over_limit_qty) above which a cart
-- line can't be self-served the normal way. What happens above the threshold
-- is chosen per item (over_limit_action):
--   'quote'    — the line can't check out; the distributor is routed to a
--                "Request a quote" button (emails the office). Whole checkout
--                is blocked while such a line is present.
--   'dropship' — the WHOLE line is fulfilled direct from the supplier for that
--                order: warehouse stock cap bypassed, excluded from the
--                MachShip warehouse quote, priced via per-zone drop-ship
--                freight, and an auto-PO is raised to the supplier on payment.
--
-- This is distinct from the existing hard cap `max_order_qty` (which blocks
-- outright) and from the always-on `is_drop_ship` catalogue flag.
--
-- b2b_order_lines.is_drop_ship is a per-order SNAPSHOT: true when the line
-- ships from the supplier for THIS order (either the catalogue item is flagged
-- is_drop_ship, or the over-limit drop-ship rule fired). The PO gatherer +
-- freight booking read this line-level flag so a normally-stocked item can
-- drop-ship for one order without changing its catalogue flag.

alter table public.b2b_catalogue
  add column if not exists over_limit_qty integer,
  add column if not exists over_limit_action text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'b2b_catalogue_over_limit_action_chk'
  ) then
    alter table public.b2b_catalogue
      add constraint b2b_catalogue_over_limit_action_chk
      check (over_limit_action is null or over_limit_action in ('quote', 'dropship'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'b2b_catalogue_over_limit_qty_chk'
  ) then
    alter table public.b2b_catalogue
      add constraint b2b_catalogue_over_limit_qty_chk
      check (over_limit_qty is null or over_limit_qty >= 1);
  end if;
end $$;

alter table public.b2b_order_lines
  add column if not exists is_drop_ship boolean not null default false;
