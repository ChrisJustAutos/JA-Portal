-- ═══════════════════════════════════════════════════════════════════
-- 020_b2b_freight_carriers_machship.sql
-- Allow 'machship' as a freight-carrier provider id.
--
-- 018 created b2b_freight_carrier_connections with a CHECK constraint
-- pinning provider to ('shippit', 'starshipit', 'auspost', 'sendle').
-- Adding MachShip means widening that whitelist — the registry in
-- lib/b2b-freight-carriers.ts is updated in the same change.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE b2b_freight_carrier_connections
  DROP CONSTRAINT IF EXISTS b2b_freight_carrier_connections_provider_check;

ALTER TABLE b2b_freight_carrier_connections
  ADD CONSTRAINT b2b_freight_carrier_connections_provider_check
  CHECK (provider IN ('shippit', 'starshipit', 'auspost', 'sendle', 'machship'));
