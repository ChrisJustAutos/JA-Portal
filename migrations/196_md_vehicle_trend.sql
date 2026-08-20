-- 196_md_vehicle_trend.sql
--
-- Vehicle Trend view (Reports → Workshop Map → Vehicle Trend).
-- Aggregates the MechanicDesk fact tables (md_invoices / md_quotes, filled by
-- the daily pull in 152_workshop_map.sql) into a per-bucket, per-vehicle-group
-- series so the dashboard can draw one line per vehicle series.
--
-- Bucketing follows the dashboard's own selection, per Chris 2026-08-20:
--   • an FY selected, no month  → 12 monthly buckets (Jul..Jun)
--   • a month selected          → one bucket per day of that calendar month
--
-- Aggregating here rather than in the API keeps it to one round trip and
-- avoids paging ~16k quote rows per FY through PostgREST just to count them.

-- ── AU postcode → state ─────────────────────────────────────────────────
-- Mirrors pcState() in lib/workshop-map/postcode-state.ts. Kept in SQL too so
-- the trend can return state as a dimension without shipping raw rows.
CREATE OR REPLACE FUNCTION public.md_pc_state(pc TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN n IS NULL THEN '?'
    WHEN (n BETWEEN  200 AND  299) OR (n BETWEEN 2600 AND 2618) OR (n BETWEEN 2900 AND 2920) THEN 'ACT'
    WHEN (n BETWEEN 1000 AND 2599) OR (n BETWEEN 2619 AND 2899) OR (n BETWEEN 2921 AND 2999) THEN 'NSW'
    WHEN (n BETWEEN 3000 AND 3999) OR (n BETWEEN 8000 AND 8999) THEN 'VIC'
    WHEN (n BETWEEN 4000 AND 4999) OR (n BETWEEN 9000 AND 9999) THEN 'QLD'
    WHEN  n BETWEEN 5000 AND 5999 THEN 'SA'
    WHEN  n BETWEEN 6000 AND 6999 THEN 'WA'
    WHEN  n BETWEEN 7000 AND 7999 THEN 'TAS'
    WHEN  n BETWEEN  800 AND  999 THEN 'NT'
    ELSE '?'
  END
  FROM (SELECT NULLIF(regexp_replace(COALESCE(pc, ''), '\D', '', 'g'), '')::INT AS n) t;
$$;

-- ── The trend series ────────────────────────────────────────────────────
-- p_month_idx: NULL = whole FY in monthly buckets; 0..11 (Jul=0) = that month
-- in daily buckets. Returns one row per (bucket, vehicle_group, state) that
-- has any activity — the caller sums across states or filters to one.
--
-- Jobs mirror the map's "clear jobs" definition: non-noise, non-missing,
-- counted on issue_date. Quotes are non-missing, counted on quote_date.
-- Unlike the map dots these are NOT deduped to 1 per customer/month — a trend
-- of work volume wants every invoice and every quote.
CREATE OR REPLACE FUNCTION public.md_vehicle_trend(p_fy INT, p_month_idx INT DEFAULT NULL)
RETURNS TABLE (
  bucket        TEXT,     -- 'YYYY-MM' for monthly, 'YYYY-MM-DD' for daily
  vehicle_group TEXT,
  state         TEXT,
  jobs          BIGINT,
  quotes        BIGINT,
  job_value     NUMERIC,
  quote_value   NUMERIC
)
LANGUAGE sql STABLE
AS $$
  WITH bounds AS (
    SELECT
      CASE WHEN p_month_idx IS NULL
           THEN make_date(p_fy - 1, 7, 1)
           ELSE make_date(CASE WHEN p_month_idx < 6 THEN p_fy - 1 ELSE p_fy END,
                          CASE WHEN p_month_idx < 6 THEN 7 + p_month_idx ELSE p_month_idx - 5 END,
                          1)
      END AS start_d,
      CASE WHEN p_month_idx IS NULL
           THEN make_date(p_fy, 7, 1)
           ELSE (make_date(CASE WHEN p_month_idx < 6 THEN p_fy - 1 ELSE p_fy END,
                           CASE WHEN p_month_idx < 6 THEN 7 + p_month_idx ELSE p_month_idx - 5 END,
                           1) + INTERVAL '1 month')::DATE
      END AS end_d
  ),
  facts AS (
    SELECT i.issue_date AS d, i.vehicle_group AS g, i.postcode AS pc,
           1::BIGINT AS j, 0::BIGINT AS q,
           COALESCE(i.total_amount, 0) AS jv, 0::NUMERIC AS qv
    FROM md_invoices i, bounds b
    WHERE i.is_noise = FALSE AND i.missing = FALSE
      AND i.issue_date >= b.start_d AND i.issue_date < b.end_d
    UNION ALL
    SELECT q.quote_date, q.vehicle_group, q.postcode,
           0::BIGINT, 1::BIGINT,
           0::NUMERIC, COALESCE(q.total_amount, 0)
    FROM md_quotes q, bounds b
    WHERE q.missing = FALSE
      AND q.quote_date >= b.start_d AND q.quote_date < b.end_d
  )
  SELECT
    CASE WHEN p_month_idx IS NULL
         THEN to_char(f.d, 'YYYY-MM')
         ELSE to_char(f.d, 'YYYY-MM-DD') END           AS bucket,
    COALESCE(f.g, 'OTH')                               AS vehicle_group,
    public.md_pc_state(f.pc)                           AS state,
    SUM(f.j)                                           AS jobs,
    SUM(f.q)                                           AS quotes,
    ROUND(SUM(f.jv))                                   AS job_value,
    ROUND(SUM(f.qv))                                   AS quote_value
  FROM facts f
  GROUP BY 1, 2, 3
  ORDER BY 1, 2, 3;
$$;

-- Read path is the service-role API (/api/workshop/map/vehicle-trend), same as
-- the rest of the workshop-map surface; no direct client access is granted.
REVOKE ALL ON FUNCTION public.md_vehicle_trend(INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.md_pc_state(TEXT)          FROM PUBLIC, anon, authenticated;

-- Supports the date-range scans above (the existing index is on fy/month/group).
CREATE INDEX IF NOT EXISTS md_invoices_issue_date_idx ON public.md_invoices (issue_date);
CREATE INDEX IF NOT EXISTS md_quotes_quote_date_idx   ON public.md_quotes   (quote_date);
