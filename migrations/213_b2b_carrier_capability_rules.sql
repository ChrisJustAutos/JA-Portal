-- 213_b2b_carrier_capability_rules.sql
--
-- Which carriers may be offered for which shape of consignment.
--
-- Chris, 2026-08-31: "Hi trans wont send individual consignments so that needs
-- to be set as a rule." Until now there was no carrier filtering at all: the
-- quoter offered every route MachShip returned and the cart auto-selected the
-- cheapest, so a consignment of loose cartons could be pre-selected onto a
-- pallet-only linehaul carrier. Nothing had shipped that way (all 14 booked
-- orders were TNT Road Express) but a quote had already shown it.
--
-- Matching is by NAME, case-insensitive substring, because MachShip's carrier
-- ids are not documented anywhere we control and a rename is likelier than an
-- id change. machship_carrier_id is here so an exact id can be pinned later
-- once observed in a live quote; when set it wins over the name match.

create table if not exists public.b2b_freight_carrier_rules (
  id                    uuid primary key default gen_random_uuid(),
  -- Case-insensitive substring of the MachShip carrier name, e.g. 'hi-trans'.
  carrier_name_match    text not null,
  -- Exact MachShip carrier id, once known. Takes precedence over the name.
  machship_carrier_id   integer,
  -- true  = only offer this carrier when EVERY item is a pallet/skid.
  pallets_only          boolean not null default false,
  -- true  = never offer this carrier at all (kill switch, no deploy needed).
  blocked               boolean not null default false,
  notes                 text,
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.b2b_freight_carrier_rules is
  'Carrier eligibility by consignment shape for B2B live freight quoting. Applied in quoteLiveRates() before the cheapest-per-carrier collapse, so an ineligible carrier is never offered and can never be auto-selected.';

create index if not exists b2b_freight_carrier_rules_active_idx
  on public.b2b_freight_carrier_rules (is_active) where is_active;

insert into public.b2b_freight_carrier_rules (carrier_name_match, pallets_only, notes)
select 'hi-trans', true,
       'Hi-Trans will not carry individual/loose consignments - pallets only. Chris, 2026-08-31.'
where not exists (
  select 1 from public.b2b_freight_carrier_rules where lower(carrier_name_match) = 'hi-trans'
);

-- MachShip spells it several ways in the wild; both spellings match the same
-- carrier and a duplicate rule is harmless (rules are OR-ed per carrier).
insert into public.b2b_freight_carrier_rules (carrier_name_match, pallets_only, notes)
select 'hi trans', true, 'Spelling variant of hi-trans.'
where not exists (
  select 1 from public.b2b_freight_carrier_rules where lower(carrier_name_match) = 'hi trans'
);

-- MachShip spells carriers inconsistently; the separator-less form matched
-- nothing, which would have silently disabled the rule.
insert into public.b2b_freight_carrier_rules (carrier_name_match, pallets_only, notes)
select 'hitrans', true, 'Spelling variant with no separator - MachShip spells carriers inconsistently.'
where not exists (
  select 1 from public.b2b_freight_carrier_rules where lower(carrier_name_match) = 'hitrans'
);
