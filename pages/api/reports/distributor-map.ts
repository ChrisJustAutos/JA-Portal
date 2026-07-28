// pages/api/reports/distributor-map.ts
// Distributor Report map (Reports → Distributor Map): JA quotes done in each
// distributor's AREA vs the jobs that distributor actually BOOKED (Monday
// "Distributor - Booking" board — confirmed group only, same filter as the
// sales recap), month by month across a financial year.
//
//   • Quotes  — the geocoded MD quote points already cached per-FY for the
//               Workshop Map (md_workshop_map_cache payload.quotes.points).
//   • Areas   — each active b2b_distributor geocoded via its ship postcode
//               (postcode centroid, same lookup the map worker uses); a quote
//               belongs to the NEAREST distributor within ?radius km
//               (default 100).
//   • Booked  — Monday board 1923220718 rows (fetchDistBookings), grouped by
//               the board's Distributor label + month. Labels are matched to
//               b2b_distributors by name; a label that matches nothing (or
//               matches ambiguously, e.g. "Hunter Mechanical" vs two Hunter
//               branches) becomes its own coord-less entity — bookings still
//               show, area quotes don't.
//
// GET ?fy=2026&radius=100 · auth view:reports.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { fetchDistBookings } from '../../../lib/sales-recap-monday'
import { fyMonths } from '../../../lib/workshop-map/vehicle-classification'
import postcodes from '../../../lib/workshop-map/au-postcodes.json'

export const config = { maxDuration: 60 }

const PC: Record<string, [number, number, string]> = (postcodes as any).pc

interface MonthCell { quotes: number; quotesValue: number; bookings: number; bookingsValue: number }
interface DistributorOut {
  key: string
  name: string
  lat: number | null
  lng: number | null
  suburb: string | null
  monthly: MonthCell[]         // aligned to months[]
  totals: MonthCell
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

// Match a Monday Distributor label to b2b_distributors by name tokens.
// Returns the matched index ONLY when exactly one candidate matches.
function matchLabel(label: string, names: string[]): number | null {
  const l = norm(label)
  if (!l) return null
  const lTokens = l.split(' ')
  const hits: number[] = []
  for (let i = 0; i < names.length; i++) {
    const n = norm(names[i])
    if (!n) continue
    if (n === l || n.includes(l) || l.includes(n)) { hits.push(i); continue }
    // token-subset either way ("CP Performance" ⊆ "CP Performance Pty Ltd")
    const nTokens = n.split(' ')
    if (lTokens.every(t => nTokens.includes(t)) || nTokens.every(t => lTokens.includes(t))) hits.push(i)
  }
  return hits.length === 1 ? hits[0] : null
}

export default withAuth('view:reports', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const token = process.env.MONDAY_API_TOKEN
  if (!token) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const radiusKm = Math.min(500, Math.max(10, Number(req.query.radius) || 100))

  // FY selection — same defaulting as the workshop map API.
  const { data: fyRows, error: fyErr } = await db.from('md_workshop_map_cache')
    .select('fy, synced_at, quote_count:payload->quotes->meta->total_quotes')
    .order('fy', { ascending: false })
  if (fyErr) return res.status(500).json({ error: fyErr.message })
  const fys = (fyRows || []).map(r => r.fy)
  if (!fys.length) return res.status(200).json({ fy: null, fys: [], distributors: [], quotePoints: [], months: [] })
  const defaultFy = (fyRows || []).find(r => Number((r as any).quote_count) >= 500)?.fy ?? fys[fys.length - 1]
  const wanted = Number(req.query.fy)
  const fy = fys.includes(wanted) ? wanted : defaultFy

  const { data: cache, error: cacheErr } = await db.from('md_workshop_map_cache')
    .select('payload, synced_at').eq('fy', fy).single()
  if (cacheErr) return res.status(500).json({ error: cacheErr.message })
  const quotePts: any[] = cache?.payload?.quotes?.points || []
  const months: { k: string; label: string }[] = cache?.payload?.months || fyMonths(fy)

  // Distributors + coords. JA's own b2b_distributors row ("Vehicle
  // Performance Solutions T/A Just Autos", Nambour) is excluded — HQ isn't a
  // distributor area and would soak up every Sunshine Coast quote.
  const { data: distRows, error: dErr } = await db.from('b2b_distributors')
    .select('id, display_name, ship_suburb, ship_state, ship_postcode')
    .eq('is_active', true).order('display_name')
  if (dErr) return res.status(500).json({ error: dErr.message })
  const excludeNames = (process.env.DISTRIBUTOR_MAP_EXCLUDE || 'just autos')
    .split(/[,;]+/).map(norm).filter(Boolean)
  const dists = (distRows || []).filter(d => !excludeNames.some(x => norm(d.display_name).includes(x)))

  const emptyCell = (): MonthCell => ({ quotes: 0, quotesValue: 0, bookings: 0, bookingsValue: 0 })
  const entities: DistributorOut[] = (dists || []).map(d => {
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
  const fyStart = `${fy - 1}-07-01`
  const fyEnd = `${fy}-06-30`
  const bookings = await fetchDistBookings(token, fyStart, fyEnd)
  const names = entities.map(e => e.name)
  const labelEntity = new Map<string, DistributorOut>()
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

  // Assign each quote point to the nearest distributor within radius.
  const located = entities.filter(e => e.lat != null && e.lng != null)
  const outPoints: { la: number; ln: number; m: number; a: number; d: string | null }[] = []
  for (const q of quotePts) {
    if (q.la == null || q.ln == null || q.m == null) continue
    let best: DistributorOut | null = null
    let bestKm = radiusKm
    for (const e of located) {
      const km = haversineKm(q.la, q.ln, e.lat!, e.lng!)
      if (km <= bestKm) { best = e; bestKm = km }
    }
    if (best) {
      best.monthly[q.m].quotes++
      best.monthly[q.m].quotesValue += Number(q.a) || 0
    }
    outPoints.push({ la: q.la, ln: q.ln, m: q.m, a: Number(q.a) || 0, d: best?.key || null })
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
  // Drop entities with zero activity everywhere (no quotes in area, no bookings).
  const active = entities.filter(e => e.totals.quotes || e.totals.bookings)

  res.setHeader('Cache-Control', 'private, max-age=300')
  return res.status(200).json({
    fy, fys, radiusKm, months,
    distributors: active,
    quotePoints: outPoints,
    quotesSyncedAt: cache?.synced_at || null,
    bookingsAsOf: new Date().toISOString(),
  })
})
