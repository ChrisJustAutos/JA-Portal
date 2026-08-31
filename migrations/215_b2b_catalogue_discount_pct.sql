-- 215 — B2B catalogue: trade price follows RRP by percentage.
--
-- THE PROBLEM
-- `trade_price_ex_gst` was a frozen number. `rrp_ex_gst` refreshes from MYOB on
-- every sync (hourly since 2026-09-01), so a price rise in MYOB moved the RRP
-- and left the trade price where it was — an item deliberately set at "20% off
-- RRP" quietly became a deeper discount, and nothing reported it. Chris,
-- 2026-09-01: "It should always work off % of RRP if it updates."
--
-- THE FIX
-- Store the INTENT (the percentage) rather than only the outcome (the price).
--
--   discount_pct IS NOT NULL  →  trade_price_ex_gst is DERIVED, and recomputed
--                                as round(rrp_ex_gst * (1 - pct/100), 2) on
--                                every catalogue sync and whenever RRP moves.
--   discount_pct IS NULL      →  trade price is PINNED: hand-set, ignored by
--                                the sync. This is the old behaviour and stays
--                                available for items priced independently of
--                                RRP.
--
-- Typing a trade price by hand clears discount_pct (the API does this), so a
-- manual price is never silently overwritten by the next sync. Setting a
-- percentage recomputes the price immediately.
--
-- BACKFILL — only where the percentage is provably the intent.
-- A percentage is adopted only if deriving from it reproduces the stored trade
-- price to the cent. Live data when this was written: of 83 priced items, 81
-- sit on an exact whole-number discount (31 at 15%, 19 at 0%, 17 at 25%, 10 at
-- 20%, 2 at 10%, and one each at 40% and 60%). The two that do not —
-- TGFK - 1VDT at 17.441% and H-M04-00 at 25.624% — are left PINNED rather than
-- rounded to 17% and 26%: they look like prices that already drifted off 15%
-- and 25%, and guessing which would change what a distributor pays. They are
-- for a human to decide.
--
-- Note the 19 items at 0%: trade price equals RRP, which is what first-time
-- ingest seeds when nobody has priced the item yet. They are recorded as 0% so
-- they track RRP rather than freezing, but they are worth reviewing — a
-- distributor buying at full RRP is usually not the intent.
--
-- Apply to Supabase project qtiscbvhlvdvafwtdtcd via apply_migration.

alter table public.b2b_catalogue
  add column if not exists discount_pct numeric(5,2);

comment on column public.b2b_catalogue.discount_pct is
  'Percent off rrp_ex_gst. NOT NULL = trade_price_ex_gst is derived and kept in step with RRP by the catalogue sync. NULL = trade price is pinned/hand-set and the sync leaves it alone.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'b2b_catalogue_discount_pct_range'
  ) then
    alter table public.b2b_catalogue
      add constraint b2b_catalogue_discount_pct_range
      check (discount_pct is null or (discount_pct >= 0 and discount_pct <= 100));
  end if;
end $$;

-- Adopt the percentage ONLY where it reproduces the stored price exactly.
update public.b2b_catalogue
   set discount_pct = round(100.0 * (1 - trade_price_ex_gst / rrp_ex_gst))
 where rrp_ex_gst > 0
   and trade_price_ex_gst > 0
   and discount_pct is null
   and round(
         rrp_ex_gst * (1 - round(100.0 * (1 - trade_price_ex_gst / rrp_ex_gst)) / 100.0),
         2
       ) = round(trade_price_ex_gst, 2);
