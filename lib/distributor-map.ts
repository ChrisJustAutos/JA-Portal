// lib/distributor-map.ts
// Core of the Distributor Map report: JA quotes done in each distributor's
// AREA (nearest-within-radius over the workshop-map geocoded quote points)
// vs the jobs that distributor BOOKED (Monday "Distributor - Booking" board,
// confirmed group). Shared by /api/reports/distributor-map (interactive page)
// and the weekly sales recap's "Distributor Areas" section.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchDistBookings } from './sales-recap-monday'
import { fyMonths } from './workshop-map/vehicle-classification'
import postcodes from './workshop-map/au-postcodes.json'

const PC: Record<string, [number, number, string]> = (postcodes as any).pc

// Just Autos' own workshop, shown on the map as a pin and radius like any
// distributor so you can see the demand around it — 1 Windsor Road, Burnside
// QLD 4560. It is QUOTES ONLY and never carries bookings: the Monday
// "Distributor - Booking" board is distributors' work, JA is not on it, and
// JA's own jobs live in MechanicDesk on a different footing (a distributor's
// bookings are counted wherever the customer is, JA's would be geographic),
// so a capture rate for JA would be comparing two different things. Its cells
// render as "—" rather than 0%, and it is excluded from the distributor totals.
// Override the location with DISTRIBUTOR_MAP_HOME_POSTCODE if the site moves.
/** Postcode → [lat, lng, suburb]. The only source of distributor coordinates. */
export function geoForPostcode(postcode: string | null | undefined): [number, number, string] | null {
  const pc = String(postcode || '').replace(/\D/g, '')
  return pc ? (PC[pc] || null) : null
}

/**
 * Just Autos' own workshop as a place on the map.
 *
 * It has to compete for quotes alongside the distributors or its own backyard
 * reads as somebody else's territory — or as nobody's at all, which is what
 * Chris spotted on the marketing report: Sunshine Coast suburbs listed under
 * "no distributor nearby" when the workshop is right there.
 *
 * Quotes only, never jobs: it is not a distributor and must never pick up
 * distributor work.
 */
export function homeWorkshop(): { name: string; lat: number; lng: number; suburb: string | null } | null {
  const geo = geoForPostcode(HOME_POSTCODE)
  return geo ? { name: HOME_NAME, lat: geo[0], lng: geo[1], suburb: geo[2] || null } : null
}

const HOME_KEY = 'ja:home'
const HOME_NAME = 'Just Autos (workshop)'
const HOME_POSTCODE = (process.env.DISTRIBUTOR_MAP_HOME_POSTCODE || '4560').replace(/\D/g, '')

export interface MonthCell { quotes: number; quotesValue: number; bookings: number; bookingsValue: number }
export interface DistributorEntity {
  key: string
  name: string
  lat: number | null
  lng: number | null
  suburb: string | null
  monthly: MonthCell[]         // aligned to months[]
  totals: MonthCell
  /** Just Autos' own workshop — quotes only, never any bookings. Consumers
   *  must show its capture rate as "—" (not 0%) and leave it out of the
   *  distributor totals, or the report reads as a distributor booking nothing. */
  quotesOnly?: boolean
}
export interface DistributorMapResult {
  fy: number
  fys: number[]
  radiusKm: number
  months: { k: string; label: string }[]
  entities: DistributorEntity[]          // zero-activity entities already dropped
  points: { la: number; ln: number; m: number; a: number; d: string | null }[]
  quotesSyncedAt: string | null
}

const norm = (s: any) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371
  const dLat = (bLat - aLat) * Math.PI / 180
  const dLng = (bLng - aLng) * Math.PI / 180
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

// Match a Monday Distributor label to b2b_distributors by name. Returns the
// matched index ONLY when exactly one candidate matches — "Hunter Mechanical"
// matches BOTH Hunter branches, so it deliberately stays unmatched. Rules
// (checked against the real board labels 2026-07-29):
//   1. contains either way on SPACE-STRIPPED names — "Bananacoast Diesel
//      Performance" ↔ "Banana Coast Diesel Performance", "Diesel Gas" ↔
//      "DieselGas Moree"
//   2. token-subset either way — "Torrisi Motorsport - Yeppoon" ↔ "Torrisi
//      Motorsport", "Morpowa" ↔ "Morpowa Auto & Dyno"
//   3. unique first-token (≥4 chars) — "Weirys - Darwin" ↔ "Weirys Diesel &
//      Mechanical Services", "Harrop Melbourne" ↔ "Harrop Engineering"
/**
 * Exported so the Workshop Map can reuse it. Distributor names reach us from
 * three different systems that spell them three different ways - MYOB's
 * customer base, Monday's booking labels, and b2b_distributors' display name -
 * and this is the matcher that already reconciles the last two. A second,
 * subtly different matcher for the same job is how the same distributor ends up
 * in two places on one dashboard.
 */
export function matchLabel(label: string, names: string[]): number | null {
  const l = norm(label)
  if (!l) return null
  const lSquash = l.replace(/ /g, '')
  const lTokens = l.split(' ')
  const hits = new Set<number>()
  for (let i = 0; i < names.length; i++) {
    const n = norm(names[i])
    if (!n) continue
    const nSquash = n.replace(/ /g, '')
    if (nSquash === lSquash || nSquash.includes(lSquash) || lSquash.includes(nSquash)) { hits.add(i); continue }
    const nTokens = n.split(' ')
    if (lTokens.every(t => nTokens.includes(t)) || nTokens.every(t => lTokens.includes(t))) hits.add(i)
  }
  if (hits.size === 1) return Array.from(hits)[0]
  if (hits.size === 0 && lTokens[0]?.length >= 4) {
    const firstHits = names.map((n, i) => ({ n: norm(n), i })).filter(x => x.n.split(' ').includes(lTokens[0]))
    if (firstHits.length === 1) return firstHits[0].i
  }
  return null
}

// One month's per-distributor comparison — the weekly sales recap's
// "Distributor Areas" section. Quote points only carry a MONTH (no day), so
// the recap section is a month snapshot, not a week one.
export interface DistributorAreaRow {
  name: string; located: boolean
  quotes: number; quotesValue: number
  bookings: number; bookingsValue: number
}
export function distributorAreasForMonth(
  result: DistributorMapResult, monthKey: string,
): { monthKey: string; monthLabel: string; radiusKm: number; rows: DistributorAreaRow[] } | null {
  const mi = result.months.findIndex(m => m.k === monthKey)
  if (mi < 0) return null
  const rows = result.entities
    // Just Autos' workshop is a map pin, not a distributor — it would show in
    // the weekly recap as a distributor that booked nothing all month.
    .filter(e => !e.quotesOnly)
    .map(e => ({
      name: e.name, located: e.lat != null,
      quotes: e.monthly[mi].quotes, quotesValue: e.monthly[mi].quotesValue,
      bookings: e.monthly[mi].bookings, bookingsValue: e.monthly[mi].bookingsValue,
    }))
    .filter(r => r.quotes || r.bookings)
    .sort((a, b) => b.quotes - a.quotes || b.bookingsValue - a.bookingsValue)
  return { monthKey, monthLabel: result.months[mi].label, radiusKm: result.radiusKm, rows }
}

/**
 * Build the full per-FY distributor picture. `fyWanted` falls back to the
 * newest FY with a meaningful quote count (same defaulting as the workshop
 * map). Returns null when the workshop-map cache is empty.
 */
export async function computeDistributorMap(
  db: SupabaseClient,
  mondayToken: string,
  opts: { fy?: number; radiusKm?: number } = {},
): Promise<DistributorMapResult | null> {
  const radiusKm = Math.min(500, Math.max(10, opts.radiusKm || 100))

  const { data: fyRows, error: fyErr } = await db.from('md_workshop_map_cache')
    .select('fy, synced_at, quote_count:payload->quotes->meta->total_quotes')
    .order('fy', { ascending: false })
  if (fyErr) throw new Error(fyErr.message)
  const fys = (fyRows || []).map(r => r.fy)
  if (!fys.length) return null
  const defaultFy = (fyRows || []).find(r => Number((r as any).quote_count) >= 500)?.fy ?? fys[fys.length - 1]
  const fy = opts.fy && fys.includes(opts.fy) ? opts.fy : defaultFy

  const { data: cache, error: cacheErr } = await db.from('md_workshop_map_cache')
    .select('payload, synced_at').eq('fy', fy).single()
  if (cacheErr) throw new Error(cacheErr.message)
  const quotePts: any[] = cache?.payload?.quotes?.points || []
  const months: { k: string; label: string }[] = cache?.payload?.months || fyMonths(fy)

  // Distributors + coords. JA's own b2b_distributors row is excluded — HQ
  // isn't a distributor area and would soak up every Sunshine Coast quote.
  const { data: distRows, error: dErr } = await db.from('b2b_distributors')
    .select('id, display_name, ship_suburb, ship_state, ship_postcode')
    .eq('is_active', true).order('display_name')
  if (dErr) throw new Error(dErr.message)
  const excludeNames = (process.env.DISTRIBUTOR_MAP_EXCLUDE || 'just autos')
    .split(/[,;]+/).map(norm).filter(Boolean)
  const dists = (distRows || []).filter(d => !excludeNames.some(x => norm(d.display_name).includes(x)))

  const emptyCell = (): MonthCell => ({ quotes: 0, quotesValue: 0, bookings: 0, bookingsValue: 0 })
  const entities: DistributorEntity[] = dists.map(d => {
    const pc = String(d.ship_postcode || '').replace(/\D/g, '')
    const geo = PC[pc]
    return {
      key: `b2b:${d.id}`,
      name: d.display_name,
      lat: geo ? geo[0] : null,
      lng: geo ? geo[1] : null,
      suburb: d.ship_suburb || (geo ? geo[2] : null),
      monthly: months.map(emptyCell),
      totals: emptyCell(),
    }
  })

  // Monday bookings for the FY window (confirmed-group filter inside).
  const bookings = await fetchDistBookings(mondayToken, `${fy - 1}-07-01`, `${fy}-06-30`)
  const names = entities.map(e => e.name)
  const labelEntity = new Map<string, DistributorEntity>()
  for (const b of bookings) {
    if (!b.date) continue
    const mi = months.findIndex(m => m.k === b.date!.slice(0, 7))
    if (mi < 0) continue
    const label = b.distributor || 'Unassigned'
    let ent = labelEntity.get(label)
    if (!ent) {
      const idx = matchLabel(label, names)
      ent = idx != null ? entities[idx] : {
        key: `label:${norm(label).replace(/ /g, '-')}`,
        name: label, lat: null, lng: null, suburb: null,
        monthly: months.map(emptyCell), totals: emptyCell(),
      }
      if (idx == null) entities.push(ent)
      labelEntity.set(label, ent)
    }
    ent.monthly[mi].bookings++
    ent.monthly[mi].bookingsValue += b.value
  }

  // Just Autos' own workshop joins AFTER the booking pass and BEFORE the quote
  // pass: it must compete for quotes on the same nearest-within-radius rule as
  // everyone else, but must never pick up a Monday booking. Adding it earlier
  // would put it in `names` and let matchLabel bind a distributor label to it —
  // and would shift the indices matchLabel returns.
  const homeGeo = PC[HOME_POSTCODE]
  if (homeGeo) {
    entities.push({
      key: HOME_KEY,
      name: HOME_NAME,
      lat: homeGeo[0],
      lng: homeGeo[1],
      suburb: homeGeo[2],
      monthly: months.map(emptyCell),
      totals: emptyCell(),
      quotesOnly: true,
    })
  }

  // Assign each quote point to the nearest distributor within radius.
  const located = entities.filter(e => e.lat != null && e.lng != null)
  const points: DistributorMapResult['points'] = []
  for (const q of quotePts) {
    if (q.la == null || q.ln == null || q.m == null) continue
    let best: DistributorEntity | null = null
    let bestKm = radiusKm
    for (const e of located) {
      const km = haversineKm(q.la, q.ln, e.lat!, e.lng!)
      if (km <= bestKm) { best = e; bestKm = km }
    }
    if (best) {
      best.monthly[q.m].quotes++
      best.monthly[q.m].quotesValue += Number(q.a) || 0
    }
    points.push({ la: q.la, ln: q.ln, m: q.m, a: Number(q.a) || 0, d: best?.key || null })
  }

  const r2 = (n: number) => Math.round(n * 100) / 100
  for (const e of entities) {
    for (const c of e.monthly) {
      c.quotesValue = r2(c.quotesValue); c.bookingsValue = r2(c.bookingsValue)
      e.totals.quotes += c.quotes; e.totals.quotesValue += c.quotesValue
      e.totals.bookings += c.bookings; e.totals.bookingsValue += c.bookingsValue
    }
    e.totals.quotesValue = r2(e.totals.quotesValue)
    e.totals.bookingsValue = r2(e.totals.bookingsValue)
  }

  return {
    fy, fys, radiusKm, months,
    entities: entities.filter(e => e.totals.quotes || e.totals.bookings),
    points,
    quotesSyncedAt: cache?.synced_at || null,
  }
}
