-- 183: Xero migration mapping tables (MYOB→Xero cutover).
--
-- xero_account_map:  MYOB account DisplayID (e.g. '1-1230') → Xero account
--                    code, per entity label (VPS/JAWS). Seeded during the
--                    chart-of-accounts mapping pass; the accounting adapter
--                    seam resolves through this before posting.
-- xero_contact_map:  MYOB contact UID → Xero ContactID, per entity, so
--                    re-posts and historical references resolve to the same
--                    Xero contact instead of creating duplicates.
-- b2b_distributors:  gains a direct xero_contact_id so B2B invoicing can
--                    address the Xero contact without a lookup hop.

CREATE TABLE IF NOT EXISTS public.xero_account_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity text NOT NULL,                -- 'VPS' | 'JAWS'
  myob_display_id text NOT NULL,       -- MYOB account DisplayID, e.g. '4-1100'
  xero_account_code text NOT NULL,     -- Xero chart-of-accounts Code, e.g. '200'
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  UNIQUE (entity, myob_display_id)
);
ALTER TABLE public.xero_account_map ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.xero_contact_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity text NOT NULL,                -- 'VPS' | 'JAWS'
  myob_uid text NOT NULL,              -- MYOB contact UID (customer or supplier)
  xero_contact_id text NOT NULL,       -- Xero ContactID (guid)
  contact_name text,                   -- denormalised for readability/debugging
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  UNIQUE (entity, myob_uid)
);
ALTER TABLE public.xero_contact_map ENABLE ROW LEVEL SECURITY;

-- B2B distributors get a direct Xero contact link (counterpart of their
-- existing MYOB customer link).
ALTER TABLE public.b2b_distributors
  ADD COLUMN IF NOT EXISTS xero_contact_id text;
