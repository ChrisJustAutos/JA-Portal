-- ═══════════════════════════════════════════════════════════════════
-- 019_stripe_myob_sync_log.sql
-- Audit + idempotency log for the Stripe→MYOB JAWS backfill / backup tool.
--
-- One row per Stripe entity (invoice, charge or refund) that we've
-- attempted to push to MYOB. The UNIQUE constraint on
-- (stripe_account, stripe_entity_type, stripe_entity_id) makes the
-- push endpoint naturally idempotent — re-pushing the same Stripe
-- entity returns the existing row instead of writing a duplicate
-- invoice to MYOB.
--
-- Lifecycle:
--   pending           → row created, nothing pushed yet (dry-run preview)
--   pushed            → MYOB write succeeded; myob_invoice_uid populated
--   failed            → MYOB write attempted but errored; last_error set
--   skipped_duplicate → we found a pre-existing MYOB invoice with this
--                       Stripe id in its JournalMemo (e.g. from the old
--                       Make automation). No write performed.
--
-- Security: holds no secrets but tracks dollar amounts. RLS on with no
-- policies — only the service-role key (server-side API routes) reads
-- or writes this table.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS stripe_myob_sync_log (
  id                 BIGSERIAL PRIMARY KEY,

  -- Source: which connected Stripe account this entity came from.
  -- Matches the labels in lib/stripe-multi.ts STRIPE_ACCOUNT_LABELS.
  stripe_account     TEXT NOT NULL,

  stripe_entity_type TEXT NOT NULL
                     CHECK (stripe_entity_type IN ('invoice', 'charge', 'refund')),

  -- The Stripe id (in_..., ch_..., re_...). Globally unique within an
  -- account; we also include the account in the UNIQUE constraint to
  -- be defensive against future cross-account collisions.
  stripe_entity_id   TEXT NOT NULL,

  -- Target: which MYOB company file we wrote/will-write to. Today this
  -- is always 'JAWS' but recording it future-proofs against multi-file
  -- routing (e.g. ET → VPS, JMACX → JAWS).
  myob_company_file  TEXT NOT NULL,

  -- MYOB UIDs once the write succeeds. NULL while pending/failed.
  myob_invoice_uid   UUID,
  myob_payment_uid   UUID,
  myob_customer_uid  UUID,

  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'pushed', 'failed', 'skipped_duplicate')),

  amount_cents       INTEGER,     -- gross invoice total
  fee_cents          INTEGER,     -- Stripe fee (always positive)
  net_cents          INTEGER,     -- amount - fee (what lands in undeposited funds)

  customer_email     TEXT,
  customer_name      TEXT,

  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,

  pushed_at          TIMESTAMPTZ,

  -- Snapshot of the Stripe object at push time, for debugging.
  raw_payload        JSONB,

  -- Audit trail.
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         TEXT,        -- email of the user who triggered the push (or 'system')

  UNIQUE (stripe_account, stripe_entity_type, stripe_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_stripe_myob_sync_status
  ON stripe_myob_sync_log(status);

CREATE INDEX IF NOT EXISTS idx_stripe_myob_sync_account_pushed
  ON stripe_myob_sync_log(stripe_account, pushed_at DESC);

CREATE INDEX IF NOT EXISTS idx_stripe_myob_sync_entity
  ON stripe_myob_sync_log(stripe_entity_id);

-- Auto-touch updated_at on every UPDATE.
CREATE OR REPLACE FUNCTION stripe_myob_sync_log_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stripe_myob_sync_log_touch ON stripe_myob_sync_log;
CREATE TRIGGER trg_stripe_myob_sync_log_touch
  BEFORE UPDATE ON stripe_myob_sync_log
  FOR EACH ROW
  EXECUTE FUNCTION stripe_myob_sync_log_touch_updated_at();

ALTER TABLE stripe_myob_sync_log ENABLE ROW LEVEL SECURITY;
