-- 141_jaws_stocktake.sql
--
-- JAWS stocktake: upload an XLSX count sheet, match each SKU against MYOB
-- (JAWS company file) inventory items, show per-line variance + coverage
-- (in-stock MYOB items that weren't counted), export CSV.
--
-- Unlike the MechanicDesk stocktake (stocktake_uploads), this one runs
-- entirely in-process — MYOB is queryable over the existing AccountRight
-- OAuth connection, so there's no GitHub Action worker, no push-back, and
-- no MD-specific columns. Report-only: any adjustment is made in MYOB by hand.

create table if not exists jaws_stocktake_uploads (
  id                 uuid primary key default gen_random_uuid(),
  uploaded_by        uuid,
  uploaded_at        timestamptz not null default now(),
  filename           text not null,
  -- parsed | matching | matched | failed
  status             text not null default 'parsed',
  total_rows         int,
  parsed_rows        jsonb,
  parse_warnings     jsonb,
  notes              text,
  -- match (counts vs MYOB on-hand)
  matched_at         timestamptz,
  matched_count      int,
  unmatched_count    int,
  match_results      jsonb,
  -- coverage (which in-stock MYOB items weren't counted)
  coverage_at        timestamptz,
  in_stock_total     int,
  in_stock_uncounted int,
  coverage           jsonb
);

create index if not exists jaws_stocktake_uploads_uploaded_at_idx
  on jaws_stocktake_uploads (uploaded_at desc);

-- Mirror stocktake_uploads: RLS on, no policies. All access is via the
-- service-role key through authenticated API routes (which bypasses RLS);
-- this denies any direct anon/authenticated client access.
alter table jaws_stocktake_uploads enable row level security;
