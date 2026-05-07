-- ═══════════════════════════════════════════════════════════════════
-- 018_b2b_freight_carriers.sql
-- Stored credentials for live freight-carrier integrations.
--
-- One row per provider (shippit, starshipit, auspost, sendle). Each row
-- holds the credentials needed to call that carrier's API plus the
-- result of the most recent "test connection" probe.
--
-- This pass adds the storage + admin UI only. Quote/book/label wiring
-- per carrier comes in follow-up commits — until then b2b_freight_zones
-- (017) remains the source of truth at checkout.
--
-- Security: this table holds API secrets. RLS is on with no policies, so
-- only the service-role key (server-side admin endpoints) can read/write.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS b2b_freight_carrier_connections (
  -- The provider id is the natural primary key — only one connection per
  -- carrier per portal install. Values: 'shippit', 'starshipit', 'auspost', 'sendle'.
  provider          TEXT PRIMARY KEY
                    CHECK (provider IN ('shippit', 'starshipit', 'auspost', 'sendle')),

  is_active         BOOLEAN NOT NULL DEFAULT true,

  -- 'live' or 'sandbox'. Each provider maps it onto its own URLs/keys.
  environment       TEXT NOT NULL DEFAULT 'live'
                    CHECK (environment IN ('live', 'sandbox')),

  -- Provider-specific credential bag. Shape depends on provider — see
  -- lib/b2b-freight-carriers.ts PROVIDERS for field definitions. Stored
  -- as jsonb because no two carriers use the same field set.
  credentials       JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Result of the last /test call. Null means never tested.
  last_test_at      TIMESTAMPTZ,
  last_test_ok      BOOLEAN,
  last_test_error   TEXT,
  last_test_detail  JSONB,

  -- Audit trail
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

DROP TRIGGER IF EXISTS trg_b2b_freight_carrier_connections_updated
  ON b2b_freight_carrier_connections;
CREATE TRIGGER trg_b2b_freight_carrier_connections_updated
  BEFORE UPDATE ON b2b_freight_carrier_connections
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Lock the table to service-role only — credentials must never reach
-- a browser via PostgREST.
ALTER TABLE b2b_freight_carrier_connections ENABLE ROW LEVEL SECURITY;
