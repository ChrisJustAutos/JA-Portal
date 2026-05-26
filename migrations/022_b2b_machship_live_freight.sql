-- ═══════════════════════════════════════════════════════════════════
-- 022_b2b_machship_live_freight.sql
-- Schema additions for live MachShip freight integration:
--   * b2b_settings — global markup % + sender (pickup) address
--   * b2b_catalogue — per-product weight + outer dimensions
--   * b2b_orders — fields for the booked MachShip consignment, its
--                  current freight status, ETA, and tracking page
--
-- All additions are nullable / defaulted so existing rows and the
-- static zone-rate fallback path keep working unchanged. The rollout
-- order is migration → admin UI to enter dims & settings → cart starts
-- offering live quotes once the data is in place.
-- ═══════════════════════════════════════════════════════════════════

-- ── b2b_settings ──────────────────────────────────────────────────

ALTER TABLE public.b2b_settings
  -- % markup applied on top of MachShip's totalSellPrice before it's
  -- shown to the distributor. 20.00 = 20%.
  ADD COLUMN IF NOT EXISTS freight_markup_percent NUMERIC(6,2)
    NOT NULL DEFAULT 20.00
    CHECK (freight_markup_percent >= 0 AND freight_markup_percent <= 200),

  -- Sender (pickup) details. Every MachShip booking needs these. Held
  -- on the singleton settings row so admin can edit them in one place.
  ADD COLUMN IF NOT EXISTS machship_from_name          TEXT,
  ADD COLUMN IF NOT EXISTS machship_from_company       TEXT,
  ADD COLUMN IF NOT EXISTS machship_from_phone         TEXT,
  ADD COLUMN IF NOT EXISTS machship_from_email         TEXT,
  ADD COLUMN IF NOT EXISTS machship_from_address_line1 TEXT,
  ADD COLUMN IF NOT EXISTS machship_from_address_line2 TEXT,
  ADD COLUMN IF NOT EXISTS machship_from_suburb        TEXT,
  ADD COLUMN IF NOT EXISTS machship_from_postcode      TEXT,
  ADD COLUMN IF NOT EXISTS machship_from_state         TEXT;

-- ── b2b_catalogue ─────────────────────────────────────────────────
--
-- MachShip needs weight (kg) + length/width/height (cm) per item to
-- compute a route. The catalogue already carries freight_weight_g (g)
-- and freight_length_mm / freight_width_mm / freight_height_mm (mm)
-- from an earlier change, so this migration doesn't add new columns —
-- it just adds an index that lets the cart and the admin catalogue
-- screen quickly find visible products that haven't been measured yet.

CREATE INDEX IF NOT EXISTS b2b_catalogue_missing_dims_idx
  ON public.b2b_catalogue (id)
  WHERE b2b_visible = true
    AND (freight_weight_g IS NULL OR freight_length_mm IS NULL OR freight_width_mm IS NULL OR freight_height_mm IS NULL);

-- ── b2b_orders ────────────────────────────────────────────────────
--
-- New fields capture (a) the live quote the distributor selected at
-- checkout (carrierId, serviceId, the route snapshot, the markup % we
-- applied), (b) the MachShip consignment created from that quote when
-- admin clicks "Book via MachShip", and (c) the most recent tracking
-- state we have from MachShip — refreshed by the cron poller every
-- 30 min and on demand via the "Refresh from MachShip" button.

ALTER TABLE public.b2b_orders
  -- The route the distributor selected at checkout. Preserves the
  -- carrier+service+price snapshot so book-freight can verify the
  -- order matches what was quoted, and so we can re-quote with the
  -- same shape if the booking call needs to be retried.
  ADD COLUMN IF NOT EXISTS freight_chosen_quote      JSONB,
  ADD COLUMN IF NOT EXISTS freight_quote_markup_pct  NUMERIC(6,2),

  -- Booked consignment identifiers + carrier metadata.
  ADD COLUMN IF NOT EXISTS machship_consignment_id      TEXT,    -- numeric id, stored as text
  ADD COLUMN IF NOT EXISTS machship_consignment_number  TEXT,    -- e.g. "MS123456"
  ADD COLUMN IF NOT EXISTS machship_carrier_id          INTEGER,
  ADD COLUMN IF NOT EXISTS machship_carrier_service_id  INTEGER,
  ADD COLUMN IF NOT EXISTS freight_service_label        TEXT,    -- e.g. "Toll IPEC — Road Express"

  -- Current freight status + ETA, refreshed from MachShip.
  ADD COLUMN IF NOT EXISTS freight_eta_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS freight_status         TEXT,
  ADD COLUMN IF NOT EXISTS last_freight_poll_at   TIMESTAMPTZ,

  -- MachShip-issued token that builds the public tracking-page URL we
  -- show distributors. Stored separately so we never expose the full
  -- consignment id to the distributor side.
  ADD COLUMN IF NOT EXISTS tracking_page_access_token TEXT;

-- Speeds up the cron's "find in-flight orders that need polling"
-- query. We only care about orders that are actually shipped via
-- MachShip and not yet delivered/cancelled/refunded.
CREATE INDEX IF NOT EXISTS b2b_orders_freight_poll_idx
  ON public.b2b_orders (last_freight_poll_at NULLS FIRST)
  WHERE machship_consignment_id IS NOT NULL
    AND status NOT IN ('delivered', 'cancelled', 'refunded');

-- Tracking-page links are looked up by access token from the
-- distributor-facing order detail; keep it indexed.
CREATE INDEX IF NOT EXISTS b2b_orders_tracking_token_idx
  ON public.b2b_orders (tracking_page_access_token)
  WHERE tracking_page_access_token IS NOT NULL;
