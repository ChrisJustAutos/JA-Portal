-- 207_b2b_machship_company_id.sql
--
-- MachShip's manifest endpoint requires CompanyId. The code resolved it by
-- GETting the consignment first — but GET /apiv2/consignments/{id} is not a
-- real MachShip route: it 404s for EVERY consignment, always has, and the
-- freight poller only survives because it falls back to the
-- returnConsignmentsBy* lookups (visible in the logs as
-- "re-resolved 71024867 -> 71024867" — the SAME id, so the id was never stale;
-- the route was simply wrong). Ship Now had no such fallback, so companyId was
-- always null, and manifesting broke the moment MachShip began enforcing it.
--
-- Capture the company id where it is actually known — on the createConsignment
-- response — and keep a configurable fallback for consignments booked before
-- this column existed.

ALTER TABLE public.b2b_orders
  ADD COLUMN IF NOT EXISTS machship_company_id INT;

COMMENT ON COLUMN public.b2b_orders.machship_company_id IS
  'MachShip CompanyId that owns this consignment, captured at booking. Required by /apiv2/manifests/manifest.';

ALTER TABLE public.b2b_settings
  ADD COLUMN IF NOT EXISTS machship_company_id INT;

COMMENT ON COLUMN public.b2b_settings.machship_company_id IS
  'Fallback MachShip CompanyId used when an order has none stored (booked before 2026-08-27).';
