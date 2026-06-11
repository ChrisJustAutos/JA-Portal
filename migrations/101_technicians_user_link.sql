-- 101_technicians_user_link.sql
-- Unify "portal users" (user_profiles — logins/roles/extensions) and
-- "workshop technicians" (workshop_technicians — diary lanes). The two stay
-- separate tables (lanes are keyed by `code` on bookings/time entries, and
-- not every lane has a login or vice-versa) but are now LINKED, managed from
-- one combined Settings → Users & Staff screen.
--
-- One-time best-effort auto-link: match on PBX extension first (strongest
-- signal), then exact case-insensitive display-name match. Unmatched rows
-- are linked by hand in the UI.

ALTER TABLE public.workshop_technicians
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL;

-- A login maps to at most one technician lane.
CREATE UNIQUE INDEX IF NOT EXISTS workshop_technicians_user_idx
  ON public.workshop_technicians (user_id) WHERE user_id IS NOT NULL;

-- Auto-link by matching extension…
UPDATE public.workshop_technicians t
SET user_id = u.id
FROM public.user_profiles u
WHERE t.user_id IS NULL
  AND t.phone_ext IS NOT NULL AND t.phone_ext <> ''
  AND u.phone_extension = t.phone_ext
  AND NOT EXISTS (SELECT 1 FROM public.workshop_technicians x WHERE x.user_id = u.id);

-- …then by exact name.
UPDATE public.workshop_technicians t
SET user_id = u.id
FROM public.user_profiles u
WHERE t.user_id IS NULL
  AND u.display_name IS NOT NULL
  AND lower(trim(u.display_name)) = lower(trim(t.name))
  AND NOT EXISTS (SELECT 1 FROM public.workshop_technicians x WHERE x.user_id = u.id);
