-- 148_search_md_stock_fn.sql
--
-- Fuzzy search over md_stock_cache for the parts bot. Handles:
--   • bare part numbers ("AIR-300FFM-STD")
--   • separator / spacing / case variants ("air300ffmstd", "AIR 300FFM STD",
--     "300ffm") — matched against a normalized (alnum-only, upper) blob so the
--     dashes/spaces in the SKU and the space in "Air Box" stop mattering
--   • small typos in the part number ("AIR-300FMM-STD") — trigram similarity
--   • multi-word name queries ("VDJ200 airbox") — every normalized token must
--     appear in the normalized SKU+name blob
-- Returns rows ranked best-first with a match_score the caller can ignore.

create or replace function search_md_stock(q text, lim int default 8)
returns table (
  stock_number text,
  name         text,
  on_hand      numeric,
  available    numeric,
  allocated    numeric,
  on_order     numeric,
  alert_qty    numeric,
  bin          text,
  location     text,
  synced_at    timestamptz,
  match_score  real
)
language plpgsql
stable
as $$
declare
  qnorm text := upper(regexp_replace(coalesce(q, ''), '[^A-Za-z0-9]', '', 'g'));
  toks  text[];
begin
  -- normalized query tokens (>= 2 chars), so multi-word queries match all parts
  select array_agg(t) into toks
  from (
    select upper(regexp_replace(w, '[^A-Za-z0-9]', '', 'g')) as t
    from regexp_split_to_table(coalesce(q, ''), '\s+') as w
  ) s
  where length(t) >= 2;

  if qnorm = '' then
    return;
  end if;

  return query
  with base as (
    select
      c.*,
      upper(regexp_replace(c.stock_number, '[^A-Za-z0-9]', '', 'g')) as sku_norm,
      upper(regexp_replace(coalesce(c.stock_number, '') || ' ' || coalesce(c.name, ''), '[^A-Za-z0-9]', '', 'g')) as blob_norm
    from md_stock_cache c
  )
  select
    b.stock_number, b.name, b.on_hand, b.available, b.allocated, b.on_order,
    b.alert_qty, b.bin, b.location, b.synced_at,
    (
        (case when b.sku_norm = qnorm then 1000 else 0 end)
      + (case when b.sku_norm like '%' || qnorm || '%' then 400 else 0 end)
      + (case when b.blob_norm like '%' || qnorm || '%' then 120 else 0 end)
      + (coalesce(similarity(b.sku_norm, qnorm), 0) * 200)
      + (coalesce(similarity(b.blob_norm, qnorm), 0) * 60)
      + least(b.on_hand, 50) / 100.0
    )::real as match_score
  from base b
  where
        (toks is not null and (select bool_and(b.blob_norm like '%' || t || '%') from unnest(toks) t))
     or b.sku_norm like '%' || qnorm || '%'
     or b.sku_norm % qnorm
     or b.blob_norm % qnorm
  order by match_score desc, b.on_hand desc
  limit greatest(lim, 1);
end;
$$;
