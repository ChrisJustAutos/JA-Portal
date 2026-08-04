-- 179: per-distributor checkout kill-switch. Off = browse-only portal
-- (catalogue + cart still work, order placement is blocked server-side).
ALTER TABLE public.b2b_distributors
  ADD COLUMN IF NOT EXISTS checkout_enabled BOOLEAN NOT NULL DEFAULT TRUE;
