-- 130_b2b_freight_packaging_unboxed.sql
-- Add an "unboxed" freight-handling option for the B2B catalogue — for items
-- that aren't in a carton but ship at their own size (e.g. an exhaust that's
-- just wrapped). Behaves like 'other' (already-boxed) in the cartonizer: ships
-- at its own dimensions, never packed into a standard carton.
alter table public.b2b_catalogue drop constraint if exists b2b_catalogue_freight_packaging_check;
alter table public.b2b_catalogue add constraint b2b_catalogue_freight_packaging_check
  check (freight_packaging is null or freight_packaging in ('box', 'pallet', 'other', 'unboxed'));
