-- 103_picker_search_indexes.sql
-- Speed up the customer/vehicle entity pickers (diary booking modal + quote
-- builder). Their endpoints ILIKE on RAW columns — migration 092 only indexed
-- normalised expressions (digits-only phone, whitespace-stripped rego) for
-- the global-search RPC, so every picker keystroke was a sequential scan.
-- Postgres needs EVERY arm of an OR indexed before it will BitmapOr.
-- pg_trgm is already enabled (092).

-- /api/workshop/customers?q= → name/phone/mobile/email ILIKE (name+email had 092 indexes)
CREATE INDEX IF NOT EXISTS workshop_customers_phone_trgm
  ON public.workshop_customers USING gin (phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS workshop_customers_mobile_trgm
  ON public.workshop_customers USING gin (mobile gin_trgm_ops);

-- /api/workshop/vehicles?q= → rego/make/model ILIKE (092 indexed only
-- normalised rego/vin); list mode also matches vin raw.
CREATE INDEX IF NOT EXISTS workshop_vehicles_rego_trgm
  ON public.workshop_vehicles USING gin (rego gin_trgm_ops);
CREATE INDEX IF NOT EXISTS workshop_vehicles_make_trgm
  ON public.workshop_vehicles USING gin (make gin_trgm_ops);
CREATE INDEX IF NOT EXISTS workshop_vehicles_model_trgm
  ON public.workshop_vehicles USING gin (model gin_trgm_ops);
CREATE INDEX IF NOT EXISTS workshop_vehicles_vin_trgm
  ON public.workshop_vehicles USING gin (vin gin_trgm_ops);

-- Vehicle auto-populate fetches by owner on every customer pick.
CREATE INDEX IF NOT EXISTS workshop_vehicles_customer_idx
  ON public.workshop_vehicles (customer_id);
