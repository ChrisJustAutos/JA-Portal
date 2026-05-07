-- ═══════════════════════════════════════════════════════════════════
-- 013_myob_accounts_cache.sql
-- Local snapshot of the MYOB chart of accounts (per company file) so
-- the AP line resolver can do keyword/name-fuzzy matching without
-- hitting MYOB on every triage pass. Refreshed lazily by the resolver
-- when the snapshot is older than the TTL.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS myob_accounts_cache (
  myob_company_file TEXT NOT NULL CHECK (myob_company_file IN ('VPS','JAWS')),
  uid               UUID NOT NULL,
  display_id        TEXT NOT NULL,
  name              TEXT NOT NULL,
  type              TEXT NOT NULL,
  parent_name       TEXT,
  is_header         BOOLEAN NOT NULL DEFAULT false,
  last_synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (myob_company_file, uid)
);

CREATE INDEX IF NOT EXISTS myob_accounts_cache_name_idx
  ON myob_accounts_cache (myob_company_file, lower(name));
CREATE INDEX IF NOT EXISTS myob_accounts_cache_synced_idx
  ON myob_accounts_cache (myob_company_file, last_synced_at);
