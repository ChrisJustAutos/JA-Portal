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
