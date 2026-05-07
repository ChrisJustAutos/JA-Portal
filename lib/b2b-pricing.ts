// lib/b2b-pricing.ts
//
// One place that turns a catalogue row's pricing fields (trade price,
// promo window, volume breaks) into an effective unit price for a given
// qty + moment in time. Imported by:
//   - cart GET             — display per-line effective price
//   - cart-add API         — snapshot at add time (and the cap check)
//   - checkout API         — final price written to b2b_order_lines + Stripe
//   - distributor catalogue API + card  — display the price the buyer will pay
//
// Source of truth: the b2b_catalogue row.
//
// Rules (in order of precedence, all evaluated against `now`):
//   1. Promo window. If promo_price_ex_gst is set AND now is in
//      [promo_starts_at, promo_ends_at) (either bound NULL = open-ended),
//      the base unit price becomes promo_price_ex_gst. Otherwise the
//      base is trade_price_ex_gst.
//   2. Volume breaks. If volume_breaks contains rows whose min_qty <= qty,
//      the row with the largest matching min_qty wins and its
//      unit_price_ex_gst overrides the base.
//
// Volume breaks beat the promo when both apply at a given qty — they're
// quote-style "if you take 10+, here's our better price" overrides and
// admins set them deliberately.

export interface PricingInputs {
  trade_price_ex_gst: number
  promo_price_ex_gst: number | null
  promo_starts_at: string | null
  promo_ends_at: string | null
  volume_breaks: { min_qty: number; unit_price_ex_gst: number }[] | null | undefined
}

export interface PricingResult {
  /** Effective unit price the distributor pays at this qty. */
  unit_price_ex_gst: number
  /** Trade price for reference (for "save vs trade" hints). */
  trade_price_ex_gst: number
  /** Whether a promo unit price applied (i.e. promo window active and no
   *  volume break overrode it). */
  promo_active: boolean
  /** Whether a volume break unit price applied for this qty. */
  volume_break_applied: boolean
  /** The min_qty of the volume break that applied, if any. */
  volume_break_min_qty: number | null
}

/**
 * Compute the effective unit price for `qty` at `now`. Pure function.
 */
export function applyPricing(
  item: PricingInputs,
  qty: number,
  now: Date = new Date(),
): PricingResult {
  const trade = Number(item.trade_price_ex_gst || 0)
  const promoStart = item.promo_starts_at ? Date.parse(item.promo_starts_at) : null
  const promoEnd   = item.promo_ends_at   ? Date.parse(item.promo_ends_at)   : null
  const t = now.getTime()
  const promoActive =
    item.promo_price_ex_gst != null &&
    item.promo_price_ex_gst >= 0 &&
    (promoStart == null || promoStart <= t) &&
    (promoEnd   == null || promoEnd   >  t)

  let base = promoActive ? Number(item.promo_price_ex_gst) : trade

  // Volume break — find the largest min_qty <= qty
  const breaks = (item.volume_breaks || []).filter(b =>
    Number.isFinite(b.min_qty) && b.min_qty >= 1 &&
    Number.isFinite(b.unit_price_ex_gst) && b.unit_price_ex_gst >= 0
  )
  let volumeMin: number | null = null
  let volumePrice: number | null = null
  for (const b of breaks) {
    if (b.min_qty <= qty && (volumeMin == null || b.min_qty > volumeMin)) {
      volumeMin = b.min_qty
      volumePrice = b.unit_price_ex_gst
    }
  }

  let result: PricingResult
  if (volumePrice != null) {
    result = {
      unit_price_ex_gst:    volumePrice,
      trade_price_ex_gst:   trade,
      promo_active:         false,  // volume break beat promo for this qty
      volume_break_applied: true,
      volume_break_min_qty: volumeMin,
    }
  } else {
    result = {
      unit_price_ex_gst:    base,
      trade_price_ex_gst:   trade,
      promo_active:         promoActive,
      volume_break_applied: false,
      volume_break_min_qty: null,
    }
  }
  return result
}

/**
 * Returns the qty cap a distributor can commit to right now. Combines
 * the available stock cap (MYOB qty − in-flight commitments) with the
 * per-item max_order_qty, picking the smaller.
 *
 * Pass `null` for either input to skip that cap. Returns `null` if no
 * cap applies (non-inventoried + no per-item max).
 */
export function effectiveQtyCap(
  stockAvailable: number | null,
  maxOrderQty: number | null,
): number | null {
  if (stockAvailable == null && maxOrderQty == null) return null
  if (stockAvailable == null) return maxOrderQty
  if (maxOrderQty == null)    return stockAvailable
  return Math.min(stockAvailable, maxOrderQty)
}
