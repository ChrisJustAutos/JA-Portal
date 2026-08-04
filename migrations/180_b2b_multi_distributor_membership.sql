-- 180: one person may belong to MULTIPLE distributor accounts (e.g. an owner
-- across several sites). Uniqueness moves from global to per-distributor.
ALTER TABLE public.b2b_distributor_users
  DROP CONSTRAINT IF EXISTS b2b_distributor_users_auth_user_id_key;
DROP INDEX IF EXISTS public.b2b_distributor_users_auth_user_id_key;
DROP INDEX IF EXISTS public.b2b_distributor_users_email_lower_idx;

CREATE UNIQUE INDEX IF NOT EXISTS b2b_dist_users_dist_email_idx
  ON public.b2b_distributor_users (distributor_id, lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS b2b_dist_users_dist_auth_idx
  ON public.b2b_distributor_users (distributor_id, auth_user_id)
  WHERE auth_user_id IS NOT NULL;
