// lib/b2b-reorder.ts
// Shared reorder/prediction maths (replicates the JAWS Stock Order Excel).
// Client-safe (no imports) so the admin sheet UI and the xlsx export stay in
// lockstep. Inputs are synced from MYOB; the calc columns are derived.

export interface ReorderSettings {
  from_date: string | null
  to_date: string | null
  growth_pct: number       // e.g. 0.2 = +20%
  forecast_months: number  // cover N months of demand
}

export interface ReorderItem {
  id: string
  sku: string
  name: string | null
  on_hand: number
  committed: number
  on_order: number
  available: number
  sales_qty: number        // total units sold over the date range
  moq: number | null
  morgans_judgment: number | null
  notes: string | null
  synced_at: string | null
  sort_order: number
}

// Inclusive month span of the date range (Jul 2025 → Mar 2026 = 9).
export function monthsInRange(from?: string | null, to?: string | null): number {
  if (!from || !to) return 1
  const f = new Date(from), t = new Date(to)
  if (isNaN(+f) || isNaN(+t)) return 1
  const m = (t.getFullYear() * 12 + t.getMonth()) - (f.getFullYear() * 12 + f.getMonth()) + 1
  return Math.max(1, m)
}

const ceil = (n: number) => Math.ceil(n - 1e-9)

export interface ReorderCalc {
  available: number; monthlyAvg: number; monthlyRound: number
  withGrowth: number; projected: number; shortfall: number
  suggested: number; finalOrder: number
}

export function computeReorder(
  it: Pick<ReorderItem, 'on_hand' | 'committed' | 'on_order' | 'sales_qty' | 'moq' | 'morgans_judgment'>,
  s: ReorderSettings, months: number,
): ReorderCalc {
  const available = (Number(it.on_hand) || 0) - (Number(it.committed) || 0)
  const monthlyAvg = (Number(it.sales_qty) || 0) / Math.max(1, months)
  const monthlyRound = ceil(monthlyAvg)
  const growth = Number(s.growth_pct) || 0
  const withGrowth = ceil(monthlyRound * (1 + growth))
  const projected = withGrowth * (Number(s.forecast_months) || 0)
  const shortfall = projected - (available + (Number(it.on_order) || 0))
  const proposedRaw = Math.max(shortfall, 0)
  const moq = Number(it.moq) || 0
  // Round up to MOQ if set; else the Excel rule (≤5 → 5, otherwise to 15s).
  const suggested = proposedRaw <= 0 ? 0
    : moq > 0 ? ceil(proposedRaw / moq) * moq
    : proposedRaw <= 5 ? 5 : ceil(proposedRaw / 15) * 15
  const finalOrder = it.morgans_judgment != null ? Number(it.morgans_judgment) : suggested
  return { available, monthlyAvg, monthlyRound, withGrowth, projected, shortfall, suggested, finalOrder }
}
