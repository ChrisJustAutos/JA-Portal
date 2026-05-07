-- ═══════════════════════════════════════════════════════════════════
-- 017_b2b_freight.sql
-- Manual freight workflow for the B2B portal:
--   - Admin configures zones (postcode ranges) + rates per zone
--   - Distributor sees available rates at checkout, picks one
--   - Admin marks order shipped from the order detail page (carrier,
--     tracking, freight cost, optional label PDF)
--
-- This is a "manual + portal-tracked" flow because InXpress (current
-- carrier) doesn't have an API. Switching to a carrier with an API
-- later just means adding rate-fetch / book-shipment endpoints; the
-- DB shape and UI surfaces are the same.
-- ═══════════════════════════════════════════════════════════════════

-- ── Zones: keyed by postcode ranges ────────────────────────────────
CREATE TABLE IF NOT EXISTS b2b_freight_zones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  -- jsonb array of { "start": "4000", "end": "4179" }. A postcode matches
  -- this zone when at least one range contains it (string comparison —
  -- AU postcodes are 4-digit so left-padded comparison works).
  postcode_ranges JSONB NOT NULL DEFAULT '[]',
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_b2b_freight_zones_updated ON b2b_freight_zones;
CREATE TRIGGER trg_b2b_freight_zones_updated
  BEFORE UPDATE ON b2b_freight_zones
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE INDEX IF NOT EXISTS b2b_freight_zones_active_idx
  ON b2b_freight_zones (is_active, sort_order);

-- ── Rates: each zone has 1+ rates (e.g. Standard, Express) ────────
CREATE TABLE IF NOT EXISTS b2b_freight_rates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id         UUID NOT NULL REFERENCES b2b_freight_zones(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  price_ex_gst    NUMERIC(10,2) NOT NULL CHECK (price_ex_gst >= 0),
  transit_days    INTEGER,                        -- estimated business days; null = unknown
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_b2b_freight_rates_updated ON b2b_freight_rates;
CREATE TRIGGER trg_b2b_freight_rates_updated
  BEFORE UPDATE ON b2b_freight_rates
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE INDEX IF NOT EXISTS b2b_freight_rates_zone_idx
  ON b2b_freight_rates (zone_id, is_active, sort_order);

-- ── Order columns ─────────────────────────────────────────────────
ALTER TABLE b2b_orders
  ADD COLUMN IF NOT EXISTS freight_method_label  TEXT,
  ADD COLUMN IF NOT EXISTS freight_cost_ex_gst   NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS freight_zone_id       UUID REFERENCES b2b_freight_zones(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS freight_rate_id       UUID REFERENCES b2b_freight_rates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tracking_url          TEXT,
  ADD COLUMN IF NOT EXISTS label_pdf_path        TEXT,
  ADD COLUMN IF NOT EXISTS shipped_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL;
