// lib/b2b-payment.ts
// Payment surcharge helpers shared by the cart (client) + checkout/test-order
// (server) so the displayed fee matches what's charged. Pure — no imports, safe
// in the client bundle.
//
// PayTo recovers Stripe's PayTo fee: 1% + $0.30, CAPPED at $3.50. We gross it up
// so that after Stripe takes its fee the business nets the order total, then cap
// the surcharge at $3.50 (Stripe also caps its fee there, so adding more never
// helps). Edit the constants here if Stripe's pricing changes.

export const PAYTO_FEE_PCT = 0.01
export const PAYTO_FEE_FIXED = 0.30
export const PAYTO_FEE_CAP = 3.50

export function paytoSurchargeInc(subtotalInc: number): number {
  if (!(subtotalInc > 0)) return 0
  const grossedUp = (subtotalInc * PAYTO_FEE_PCT + PAYTO_FEE_FIXED) / (1 - PAYTO_FEE_PCT)
  return Math.round(Math.min(grossedUp, PAYTO_FEE_CAP) * 100) / 100
}

/**
 * Have payment surcharges been switched off?
 *
 * b2b_settings.payment_surcharge_ends_on is a DATE in Brisbane terms. On and
 * after it, every surcharge - card, PayTo and BECS - is zero. Set to
 * 2026-10-01 (Chris, 2026-08-31). The underlying card_fee_percent /
 * card_fee_fixed are deliberately left as they are, so this is reversed by
 * clearing the date rather than by remembering the old rates.
 *
 * Compared on the Brisbane calendar date, not UTC: 1 October in Brisbane
 * begins at 14:00 UTC on 30 September, and a distributor checking out at
 * 09:00 on the 1st must not still be charged.
 */
export function surchargesEnded(endsOn: string | null | undefined, now: Date = new Date()): boolean {
  if (!endsOn) return false
  const bris = new Date(now.getTime() + 10 * 3600_000)   // UTC+10, no DST
  return bris.toISOString().slice(0, 10) >= String(endsOn).slice(0, 10)
}
