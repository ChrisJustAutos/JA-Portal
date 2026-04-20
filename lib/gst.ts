// lib/gst.ts
// Single source of truth for GST normalisation across all API routes.
//
// MYOB stores amounts differently depending on the `IsTaxInclusive` flag on
// the parent invoice/bill/quote:
//   IsTaxInclusive=true  → TotalAmount, Subtotal, and line Total are INC-GST
//   IsTaxInclusive=false → same fields are already EX-GST
//
// The ProfitAndLossSummaryReport is ALWAYS ex-GST (MYOB P&L convention).
// Items.CurrentValue (inventory) is ALWAYS ex-GST.
//
// Every API route should normalise to ex-GST before returning to the frontend.
// The frontend's `usePreferences()` hook decides whether to display as inc-GST
// (multiply by 1.1) or ex-GST (as-is).

// ── Invoice-level normalisation ─────────────────────────────────────────
// Use this for SaleInvoices / PurchaseBills / SaleOrders / SaleQuotes totals.
// The cleanest formula: TotalAmount - TotalTax = ex-GST, regardless of
// IsTaxInclusive. This works because MYOB's TotalTax is the actual GST amount
// for taxable lines, zero for GST-free lines. Sum is consistent.

export function invoiceExGst(totalAmount: number | null | undefined, totalTax: number | null | undefined): number {
  const t = Number(totalAmount) || 0
  const tax = Number(totalTax) || 0
  return t - tax
}

// Alternative for when TotalTax isn't available — compute from flag.
// amount: the raw TotalAmount value. isTaxInclusive: true/false from the invoice.
// Assumes the invoice has only GST-taxable lines (so /1.1 is right).
// SAFER to use invoiceExGst() when TotalTax is available.
export function invoiceExGstFromFlag(amount: number | null | undefined, isTaxInclusive: boolean | null | undefined): number {
  const a = Number(amount) || 0
  return isTaxInclusive ? a / 1.1 : a
}

// ── Line-item normalisation ─────────────────────────────────────────────
// Line items don't have their own TotalTax — we need both the parent
// invoice's IsTaxInclusive AND the line's TaxCodeCode.
//
// Logic:
//   parent inc-GST + line GST-coded  → divide by 1.1  (gross up needs reversing)
//   parent inc-GST + line GST-free   → as-is          (no GST was added)
//   parent ex-GST  + any             → as-is          (already ex-GST)

export function lineExGst(
  lineTotal: number | null | undefined,
  parentIsTaxInclusive: boolean | null | undefined,
  lineTaxCode: string | null | undefined,
): number {
  const t = Number(lineTotal) || 0
  const isGstLine = String(lineTaxCode || '').trim().toUpperCase() === 'GST'
  if (parentIsTaxInclusive && isGstLine) return t / 1.1
  return t
}

// ── Boolean coercion ────────────────────────────────────────────────────
// CData can return IsTaxInclusive as boolean, "true"/"false" strings, or 0/1.
// Normalise consistently.

export function asBool(v: any): boolean {
  if (v === true || v === 1) return true
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    return s === 'true' || s === '1' || s === 't' || s === 'yes'
  }
  return false
}

// ── Tiny helpers commonly needed alongside ──────────────────────────────

export function toNum(v: any): number {
  const n = Number(v)
  return isNaN(n) ? 0 : n
}
