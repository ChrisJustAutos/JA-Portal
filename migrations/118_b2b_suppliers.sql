-- ═══════════════════════════════════════════════════════════════════
-- 118_b2b_suppliers.sql
-- Supplier logins for the B2B portal. A supplier signs in (same Supabase
-- auth + magic-link/password flow as distributors) and sees ONLY a
-- read-only Stock Wall of the products they supply — so they can watch our
-- on-hand quantities and plan their production runs. No ordering, no prices.
--
-- A supplier maps to one or more MYOB supplier card UIDs; products are the
-- b2b_catalogue rows whose myob_supplier_uid is in that set.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.b2b_suppliers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  myob_supplier_uids TEXT[] NOT NULL DEFAULT '{}'::text[],   -- match b2b_catalogue.myob_supplier_uid
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  notes              TEXT,
  created_by         UUID REFERENCES public.user_profiles(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.b2b_suppliers ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.b2b_supplier_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id   UUID NOT NULL REFERENCES public.b2b_suppliers(id) ON DELETE CASCADE,
  auth_user_id  UUID NOT NULL,
  email         TEXT NOT NULL,
  full_name     TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  invited_at    TIMESTAMPTZ,
  invited_by    UUID REFERENCES public.user_profiles(id),
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.b2b_supplier_users ENABLE ROW LEVEL SECURITY;

-- One login email across the whole supplier space; one auth user → one row.
CREATE UNIQUE INDEX IF NOT EXISTS b2b_supplier_users_email_idx ON public.b2b_supplier_users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS b2b_supplier_users_auth_idx  ON public.b2b_supplier_users (auth_user_id);
CREATE INDEX IF NOT EXISTS b2b_supplier_users_supplier_idx     ON public.b2b_supplier_users (supplier_id);
