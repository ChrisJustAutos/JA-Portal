-- ═══════════════════════════════════════════════════════════════════
-- 092: Workshop global search
--
-- One RPC powering the workshop-wide search box (customers / vehicles /
-- jobs / invoices). All matching is done DB-side so we can normalise:
--   · phone/mobile — compared digits-only, so "0410 599 778" finds
--     "0410599778" and vice versa (also matches landlines with spaces)
--   · rego / VIN  — compared lowercased with all whitespace stripped,
--     so "254 PE4" finds "254PE4" and vice versa
--   · names/emails/numbers — plain ILIKE substring
--
-- Service-role only: the workshop tables are RLS service-only and this
-- function is SECURITY DEFINER, so EXECUTE is revoked from anon/authenticated.
-- The portal calls it through /api/workshop/search (withAuth view:diary).
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.workshop_search(p_q TEXT, p_limit INT DEFAULT 8)
RETURNS JSONB
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH norm AS (
  SELECT
    trim(p_q)                                              AS q,    -- raw, trimmed
    lower(regexp_replace(p_q, '\s+', '', 'g'))             AS qns,  -- lowercased, no whitespace (rego/vin)
    regexp_replace(p_q, '\D', '', 'g')                     AS qd,   -- digits only (phone)
    LEAST(GREATEST(coalesce(p_limit, 8), 1), 20)           AS lim
)
SELECT CASE WHEN length((SELECT q FROM norm)) < 2 THEN
  jsonb_build_object('customers','[]'::jsonb,'vehicles','[]'::jsonb,'jobs','[]'::jsonb,'invoices','[]'::jsonb)
ELSE jsonb_build_object(

  'customers', coalesce((
    SELECT jsonb_agg(row_to_json(c)::jsonb) FROM (
      SELECT cu.id, cu.name, cu.first_name, cu.last_name, cu.company,
             cu.customer_number, cu.phone, cu.mobile, cu.email
      FROM workshop_customers cu, norm n
      WHERE cu.name ILIKE '%'||n.q||'%'
         OR cu.first_name ILIKE '%'||n.q||'%'
         OR cu.last_name ILIKE '%'||n.q||'%'
         OR (coalesce(cu.first_name,'')||' '||coalesce(cu.last_name,'')) ILIKE '%'||n.q||'%'
         OR cu.company ILIKE '%'||n.q||'%'
         OR cu.email ILIKE '%'||n.q||'%'
         OR cu.customer_number ILIKE '%'||n.q||'%'
         OR (length(n.qd) >= 4 AND (
              regexp_replace(coalesce(cu.phone,''),  '\D', '', 'g') LIKE '%'||n.qd||'%'
           OR regexp_replace(coalesce(cu.mobile,''), '\D', '', 'g') LIKE '%'||n.qd||'%'))
      ORDER BY (cu.name ILIKE n.q||'%') DESC, cu.name
      LIMIT (SELECT lim FROM norm)
    ) c), '[]'::jsonb),

  'vehicles', coalesce((
    SELECT jsonb_agg(row_to_json(v)::jsonb) FROM (
      SELECT ve.id, ve.rego, ve.vin, ve.make, ve.model, ve.year, ve.colour,
             cu.id AS customer_id, cu.name AS customer_name
      FROM workshop_vehicles ve
      LEFT JOIN workshop_customers cu ON cu.id = ve.customer_id,
      norm n
      WHERE lower(regexp_replace(coalesce(ve.rego,''), '\s+', '', 'g')) LIKE '%'||n.qns||'%'
         OR lower(regexp_replace(coalesce(ve.vin,''),  '\s+', '', 'g')) LIKE '%'||n.qns||'%'
         OR (coalesce(ve.make,'')||' '||coalesce(ve.model,'')) ILIKE '%'||n.q||'%'
      ORDER BY (lower(regexp_replace(coalesce(ve.rego,''), '\s+', '', 'g')) = n.qns) DESC, ve.updated_at DESC
      LIMIT (SELECT lim FROM norm)
    ) v), '[]'::jsonb),

  'jobs', coalesce((
    SELECT jsonb_agg(row_to_json(j)::jsonb) FROM (
      SELECT bk.id, bk.status, bk.starts_at, bk.job_type, bk.description, bk.summary,
             cu.name AS customer_name,
             ve.rego, ve.make, ve.model
      FROM workshop_bookings bk
      LEFT JOIN workshop_customers cu ON cu.id = bk.customer_id
      LEFT JOIN workshop_vehicles  ve ON ve.id = bk.vehicle_id,
      norm n
      WHERE bk.description ILIKE '%'||n.q||'%'
         OR bk.summary ILIKE '%'||n.q||'%'
         OR cu.name ILIKE '%'||n.q||'%'
         OR lower(regexp_replace(coalesce(ve.rego,''), '\s+', '', 'g')) LIKE '%'||n.qns||'%'
         OR (length(n.qd) >= 4 AND (
              regexp_replace(coalesce(cu.phone,''),  '\D', '', 'g') LIKE '%'||n.qd||'%'
           OR regexp_replace(coalesce(cu.mobile,''), '\D', '', 'g') LIKE '%'||n.qd||'%'))
      ORDER BY bk.starts_at DESC
      LIMIT (SELECT lim FROM norm)
    ) j), '[]'::jsonb),

  'invoices', coalesce((
    SELECT jsonb_agg(row_to_json(iv)::jsonb) FROM (
      SELECT wi.id, wi.md_id, wi.status, wi.total, wi.created_at,
             cu.name AS customer_name
      FROM workshop_invoices wi
      LEFT JOIN workshop_customers cu ON cu.id = wi.customer_id,
      norm n
      WHERE wi.deleted_at IS NULL
        AND (wi.md_id ILIKE '%'||n.q||'%'
          OR cu.name ILIKE '%'||n.q||'%'
          OR (length(n.qd) >= 3 AND wi.md_id LIKE '%'||n.qd||'%'))
      ORDER BY (wi.md_id = n.q) DESC, wi.created_at DESC
      LIMIT (SELECT lim FROM norm)
    ) iv), '[]'::jsonb)

) END
$$;

-- Service-role only — never callable from the browser keys.
REVOKE ALL ON FUNCTION public.workshop_search(TEXT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workshop_search(TEXT, INT) FROM anon;
REVOKE ALL ON FUNCTION public.workshop_search(TEXT, INT) FROM authenticated;

-- ── Trigram indexes ──────────────────────────────────────────────────
-- Every OR arm of the customers subquery must be indexable or the planner
-- falls back to a seq scan (38k customers ≈ 400ms; with these ≈ 110ms).
-- Index expressions must match the function's WHERE clauses exactly.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS workshop_customers_name_trgm
  ON public.workshop_customers USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS workshop_customers_email_trgm
  ON public.workshop_customers USING gin (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS workshop_customers_first_name_trgm
  ON public.workshop_customers USING gin (first_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS workshop_customers_last_name_trgm
  ON public.workshop_customers USING gin (last_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS workshop_customers_fullname_trgm
  ON public.workshop_customers USING gin ((coalesce(first_name,'')||' '||coalesce(last_name,'')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS workshop_customers_company_trgm
  ON public.workshop_customers USING gin (company gin_trgm_ops);
CREATE INDEX IF NOT EXISTS workshop_customers_custnum_trgm
  ON public.workshop_customers USING gin (customer_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS workshop_customers_phone_digits_trgm
  ON public.workshop_customers USING gin ((regexp_replace(coalesce(phone,''), '\D', '', 'g')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS workshop_customers_mobile_digits_trgm
  ON public.workshop_customers USING gin ((regexp_replace(coalesce(mobile,''), '\D', '', 'g')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS workshop_vehicles_rego_norm_trgm
  ON public.workshop_vehicles USING gin ((lower(regexp_replace(coalesce(rego,''), '\s+', '', 'g'))) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS workshop_vehicles_vin_norm_trgm
  ON public.workshop_vehicles USING gin ((lower(regexp_replace(coalesce(vin,''), '\s+', '', 'g'))) gin_trgm_ops);
