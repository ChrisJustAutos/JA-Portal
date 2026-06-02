-- 063_b2b_qty_on_hand.sql
-- Store MYOB QuantityOnHand alongside QuantityAvailable. qty_available stays the
-- "can we sell right now" figure used by the checkout stock gate (on-hand minus
-- committed); qty_on_hand is the physical count shown on the admin catalogue.

alter table b2b_catalogue add column if not exists qty_on_hand integer;

-- Extend the bulk-update function to also set qty_on_hand (coalesce keeps the
-- existing value if a caller doesn't supply it).
create or replace function public.b2b_bulk_update_stock(updates jsonb)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  updated_count int := 0;
begin
  with u as (
    select *
    from jsonb_to_recordset(updates) as x(
      uid             text,
      qty             numeric,
      qty_on_hand     numeric,
      is_inventoried  boolean,
      cached_at       timestamptz
    )
  )
  update b2b_catalogue c set
    qty_available    = u.qty,
    qty_on_hand      = coalesce(u.qty_on_hand, c.qty_on_hand),
    is_inventoried   = u.is_inventoried,
    stock_cached_at  = u.cached_at
  from u
  where c.myob_item_uid = u.uid;

  get diagnostics updated_count = row_count;
  return updated_count;
end;
$function$;
