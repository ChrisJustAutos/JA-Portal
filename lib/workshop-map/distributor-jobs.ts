// lib/workshop-map/distributor-jobs.ts
//
// Distributor tunes as countable jobs on the Workshop Map's Conversion view.
//
// A distributor tune shows up in MYOB as an invoice line whose PO number IS
// THE VIN of the car being tuned (Chris, 2026-08-27). So the Distributor
// report's cached payload already holds every distributor job we need — the
// work is picking the VIN PO numbers out of the other things people type in
// that field (stock orders, customer names, estimate numbers) and turning them
// into one job per vehicle per month.
//
// Counting rule, as specified:
//   • a PO number that is a structurally valid 17-character VIN = a vehicle job
//   • ONE job per VIN per month — the same car tuned in March and again in
//     July is two jobs; two lines on one invoice is one
//   • the series comes from the VIN (see seriesFromVin)
//
// Measured on FY2026: 3,221 line items → 2,754 with a PO → 883 VINs, of which
// 873 decode to a series (98.9%). The four 17-character non-VINs it rejects are
// things like "GREG CANNON / STK".

import type { SupabaseClient } from '@supabase/supabase-js'
import { fyMonths, isVin, normaliseVin, seriesFromVin, type VehicleGroup } from './vehicle-classification'

export interface DistributorJobs {
  /** series → 12 FY months (Jul=0) → job count */
  jcount: Record<string, number[]>
  /** distinct VIN-months counted */
  total: number
  /** distinct vehicles (a car tuned twice in the year counts once here) */
  vehicles: number
  /** VINs whose series we couldn't recognise — counted, never dropped */
  unknown: number
  /** 17-char PO numbers rejected as not-a-VIN, for transparency */
  rejected: number
  /** when the distributor report payload behind this was computed */
  sourceComputedAt: string | null
}

const EMPTY: DistributorJobs = {
  jcount: {}, total: 0, vehicles: 0, unknown: 0, rejected: 0, sourceComputedAt: null,
}

/**
 * Build the distributor job counts for one financial year from the cached
 * Distributor report payload. Returns zeros (never throws) when that FY hasn't
 * been cached yet — the Conversion view degrades to workshop-only rather than
 * erroring.
 */
export async function distributorJobsForFy(db: SupabaseClient, fy: number): Promise<DistributorJobs> {
  const { data, error } = await db.from('distributors_cache')
    .select('payload, computed_at').eq('range_key', `FY${fy}`).maybeSingle()
  if (error || !data?.payload) return EMPTY

  const months = fyMonths(fy)
  const monthIndex = new Map(months.map((m, i) => [m.k, i]))

  // vin → set of FY month indexes it was invoiced in
  const seen = new Map<string, Set<number>>()
  let rejected = 0

  for (const d of ((data.payload as any).distributors || [])) {
    for (const li of (d.lineItems || [])) {
      const raw = String(li?.poNumber ?? '').trim()
      if (raw.length !== 17) continue          // only a VIN can be a vehicle job
      const vin = normaliseVin(raw)
      if (!isVin(vin)) { rejected++; continue }

      const mk = String(li?.date ?? '').slice(0, 7)   // YYYY-MM
      const mi = monthIndex.get(mk)
      if (mi == null) continue                  // outside this FY — ignore

      if (!seen.has(vin)) seen.set(vin, new Set())
      seen.get(vin)!.add(mi)
    }
  }

  const jcount: Record<string, number[]> = {}
  let total = 0, unknown = 0
  for (const [vin, monthSet] of Array.from(seen.entries())) {
    const series = (seriesFromVin(vin) || 'OTH') as VehicleGroup
    if (series === 'OTH') unknown++
    const row = (jcount[series] ||= Array(12).fill(0))
    for (const mi of Array.from(monthSet)) { row[mi]++; total++ }
  }

  return {
    jcount,
    total,
    vehicles: seen.size,
    unknown,
    rejected,
    sourceComputedAt: data.computed_at ?? null,
  }
}
