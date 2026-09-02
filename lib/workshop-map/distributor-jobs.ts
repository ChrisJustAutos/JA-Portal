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
import { matchLabel, geoForPostcode } from '../distributor-map'

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
  /**
   * The same tunes, per distributor and placed on the map. Only distributors we
   * can put a pin on appear here; see `unlocated` for the rest.
   */
  byDistributor: DistributorTunePin[]
  /**
   * Tunes we could NOT place, and whose they are. Surfaced rather than dropped:
   * 28% of FY2026's tunes are at names with no b2b_distributors row, and a map
   * that quietly omits a quarter of the work is worse than one that admits it.
   */
  unlocated: { tunes: number; names: string[] }
}

export interface DistributorTunePin {
  name: string
  lat: number
  lng: number
  suburb: string | null
  /** tunes = VIN-months, matching `total`'s counting rule */
  tunes: number
  /** distinct vehicles */
  vehicles: number
  /** series → 12 FY months (Jul=0) → tunes */
  bySeries: Record<string, number[]>
}

const EMPTY: DistributorJobs = {
  jcount: {}, total: 0, vehicles: 0, unknown: 0, rejected: 0, sourceComputedAt: null,
  byDistributor: [], unlocated: { tunes: 0, names: [] },
}

// Chris 2026-09-02: "should just be tunes carried out". The PO number is
// stamped per INVOICE onto every one of its lines, so a tune invoice that also
// carries parts lines still counts once (one job per VIN per month), while a
// parts-only or oil-only order with a VIN in the PO field no longer counts as a
// job at all. Measured on FY2026 before applying it: 887 VINs across all
// buckets, 883 from Tuning lines - so this drops 4, and makes the definition
// match the words.
const TUNE_BUCKET = 'Tuning'

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

  // distributor name → vin → set of FY month indexes
  const perDist = new Map<string, Map<string, Set<number>>>()
  // distributor name → their own address off the MYOB card, when the cache
  // carries one. This is what lets a FORMER distributor be pinned: they have no
  // b2b_distributors row, but they always had a card.
  const distGeo = new Map<string, { postcode: string | null; city: string | null; state: string | null }>()

  for (const d of ((data.payload as any).distributors || [])) {
    const distName = String(d?.customerBase ?? '').trim()
    if (distName && d?.postcode) {
      distGeo.set(distName, { postcode: d.postcode, city: d.city ?? null, state: d.state ?? null })
    }
    for (const li of (d.lineItems || [])) {
      if (String(li?.bucket ?? '') !== TUNE_BUCKET) continue   // tunes only
      const raw = String(li?.poNumber ?? '').trim()
      if (raw.length !== 17) continue          // only a VIN can be a vehicle job
      const vin = normaliseVin(raw)
      if (!isVin(vin)) { rejected++; continue }

      const mk = String(li?.date ?? '').slice(0, 7)   // YYYY-MM
      const mi = monthIndex.get(mk)
      if (mi == null) continue                  // outside this FY — ignore

      if (!seen.has(vin)) seen.set(vin, new Set())
      seen.get(vin)!.add(mi)

      if (distName) {
        if (!perDist.has(distName)) perDist.set(distName, new Map())
        const dv = perDist.get(distName)!
        if (!dv.has(vin)) dv.set(vin, new Set())
        dv.get(vin)!.add(mi)
      }
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

  // ── Place them ────────────────────────────────────────────────────────
  // Coordinates exist only for active b2b_distributors rows, via postcode. The
  // MYOB customer base and the b2b display name are different spellings of the
  // same businesses, so they are reconciled with matchLabel - the same matcher
  // that already reconciles Monday's booking labels against the same list,
  // rather than a second one that would disagree with it.
  const { data: distRows } = await db.from('b2b_distributors')
    .select('display_name, ship_suburb, ship_postcode')
    .eq('is_active', true)
  const located = (distRows || [])
    .map(r => ({ row: r, geo: geoForPostcode(r.ship_postcode) }))
    .filter(x => x.geo)
  const names = located.map(x => x.row.display_name as string)

  const pins = new Map<string, DistributorTunePin>()
  let unlocatedTunes = 0
  const unlocatedNames: string[] = []

  for (const [distName, vins] of Array.from(perDist.entries())) {
    let tunes = 0
    for (const ms of Array.from(vins.values())) tunes += ms.size

    const idx = matchLabel(distName, names)

    // No distributor record — but MYOB knows where they are. This is the whole
    // reason a former distributor can appear: BSC, MDD and Performance Tourers
    // did 110 tunes between them and had no b2b row to be found under.
    let key: string, lat: number, lng: number, suburb: string | null
    if (idx == null) {
      const own = distGeo.get(distName)
      const geo = own ? geoForPostcode(own.postcode) : null
      if (!geo) {
        unlocatedTunes += tunes
        unlocatedNames.push(distName)
        continue
      }
      key = distName
      lat = geo[0]; lng = geo[1]
      suburb = own?.city || geo[2] || null
    } else {
      const hit = located[idx]
      key = hit.row.display_name as string
      lat = hit.geo![0]; lng = hit.geo![1]
      suburb = (hit.row.ship_suburb as string) || hit.geo![2] || null
    }
    // Two MYOB customer bases can match one distributor (a branch billed
    // separately) — they share the pin rather than fighting over it.
    let pin = pins.get(key)
    if (!pin) {
      pin = { name: key, lat, lng, suburb, tunes: 0, vehicles: 0, bySeries: {} }
      pins.set(key, pin)
    }
    pin.tunes += tunes
    pin.vehicles += vins.size
    for (const [vin, monthSet] of Array.from(vins.entries())) {
      const series = (seriesFromVin(vin) || 'OTH') as VehicleGroup
      const row = (pin.bySeries[series] ||= Array(12).fill(0))
      for (const mi of Array.from(monthSet)) row[mi]++
    }
  }

  return {
    jcount,
    total,
    vehicles: seen.size,
    unknown,
    rejected,
    sourceComputedAt: data.computed_at ?? null,
    byDistributor: Array.from(pins.values()).sort((a, b) => b.tunes - a.tunes),
    unlocated: { tunes: unlocatedTunes, names: unlocatedNames.sort() },
  }
}
