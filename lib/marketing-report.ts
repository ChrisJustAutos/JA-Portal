// lib/marketing-report.ts
//
// Weekly Marketing Report — the demand side of the business, for Murph.
//
// Deliberately NOT a section bolted onto the Weekly Sales Recap. That one is
// about what the workshop sold and needs a Playwright run against MechanicDesk
// before it can be assembled; this one is about where the demand came from,
// what it asked for, and where it went unanswered, and needs none of that. Two
// audiences, two jobs, no shared failure.
//
// WHAT IS AND ISN'T WEEKLY — the one thing to keep honest here. Quote LEADS are
// captured per lead with a timestamp, so week-on-week is real. Everything drawn
// from the workshop-map cache (model mix, state spread, conversion, distributor
// areas) is MONTH-granular at best: the cached quote points carry an FY month
// index and no day. So those sections are labelled financial-year-to-date and
// must never be presented as "last week". A weekly report quietly built on
// monthly numbers gets found out in week two and believed in none after that.
//
// Read-only by construction: it reads the overnight lead store rather than
// calling captureAndLoadQuoteLeads, which takes a fresh Monday snapshot and
// writes it. A second consumer must not be able to disturb the sales recap's
// data by being run.

import type { SupabaseClient } from '@supabase/supabase-js'
import { selectAllRows } from './supabase-paged'
import { previousTradingWeek } from './sales-recap'
import { distributorJobsForFy, type DistributorTunePin } from './workshop-map/distributor-jobs'
import { pcState } from './workshop-map/postcode-state'

/** Quotes further than this from every distributor count as uncovered. */
export const COVERAGE_RADIUS_KM = 150

export interface ChannelRow { channel: string; week: number; prior: number; delta: number }
export interface ModelRow { group: string; quotes: number; value: number; jobs: number; conv: number | null }
export interface StateRow { state: string; quotes: number; value: number }
export interface CoverageRow { name: string; suburb: string | null; quotes: number; value: number; tunes: number }

export interface MarketingReport {
  week: { start: string; end: string }
  fy: number
  syncedAt: string | null
  /** WEEKLY — real, from the timestamped lead store. */
  channels: ChannelRow[]
  weekTotal: number
  priorTotal: number
  /** FY-TO-DATE — month-granular source, labelled as such everywhere it shows. */
  models: ModelRow[]
  states: StateRow[]
  totals: { quotes: number; value: number; jobs: number; conv: number | null }
  coverage: {
    radiusKm: number
    inside: { quotes: number; value: number }
    outside: { quotes: number; value: number }
    /** Where the uncovered demand is, by postcode area — the actionable bit. */
    hotspots: { label: string; state: string; quotes: number; value: number }[]
    byDistributor: CoverageRow[]
  } | null
  notes: string[]
}

const r0 = (n: number) => Math.round(n)
const haversineKm = (aLa: number, aLn: number, bLa: number, bLn: number) => {
  const R = 6371, r = Math.PI / 180
  const dLa = (bLa - aLa) * r, dLn = (bLn - aLn) * r
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(aLa * r) * Math.cos(bLa * r) * Math.sin(dLn / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Leads created inside [fromIso, toIso). Read-only — no snapshot, no capture. */
async function leadsBetween(db: SupabaseClient, fromIso: string, toIso: string) {
  return selectAllRows<any>(() => db.from('sales_recap_overnight_leads')
    .select('monday_item_id, channel, lead_created_at')
    .gte('lead_created_at', fromIso).lt('lead_created_at', toIso), 'monday_item_id')
}

export async function buildMarketingReport(
  db: SupabaseClient,
  opts: { nowMs?: number; radiusKm?: number } = {},
): Promise<MarketingReport> {
  const nowMs = opts.nowMs ?? Date.now()
  const radiusKm = opts.radiusKm ?? COVERAGE_RADIUS_KM
  const week = previousTradingWeek(nowMs)
  const notes: string[] = []

  // ── Weekly: quote leads by channel, against the week before ──────────────
  // Brisbane is UTC+10 year round, so the day boundary is a fixed offset. The
  // window runs to the END of Friday, hence +1 day on the exclusive bound.
  const dayMs = 86400_000
  const wkStart = Date.parse(`${week.start}T00:00:00+10:00`)
  const wkEnd = Date.parse(`${week.end}T00:00:00+10:00`) + dayMs
  const [thisWeek, lastWeek] = await Promise.all([
    leadsBetween(db, new Date(wkStart).toISOString(), new Date(wkEnd).toISOString()),
    leadsBetween(db, new Date(wkStart - 7 * dayMs).toISOString(), new Date(wkEnd - 7 * dayMs).toISOString()),
  ])
  const tally = (rows: any[]) => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.channel || 'Unknown', (m.get(r.channel || 'Unknown') || 0) + 1)
    return m
  }
  const tw = tally(thisWeek), lw = tally(lastWeek)
  const channels: ChannelRow[] = Array.from(new Set([...Array.from(tw.keys()), ...Array.from(lw.keys())]))
    .map(c => ({ channel: c, week: tw.get(c) || 0, prior: lw.get(c) || 0, delta: (tw.get(c) || 0) - (lw.get(c) || 0) }))
    .sort((a, b) => b.week - a.week || a.channel.localeCompare(b.channel))
  const weekTotal = channels.reduce((s, c) => s + c.week, 0)
  const priorTotal = channels.reduce((s, c) => s + c.prior, 0)
  if (weekTotal === 0) notes.push('No quote leads recorded for the week — check the overnight lead capture before reading anything into it.')

  // ── FY-to-date: the map cache ────────────────────────────────────────────
  const { data: cache } = await db.from('md_workshop_map_cache')
    .select('fy, payload, synced_at').order('fy', { ascending: false }).limit(1).maybeSingle()
  const payload: any = cache?.payload || {}
  const qPoints: any[] = payload?.quotes?.points || []
  const conv = payload?.conv || { qcount: {}, qval: {}, jcount: {} }
  const cats: { k: string; n: string }[] = payload?.cats || []
  const sum = (a: number[] | undefined) => (a || []).reduce((x, y) => x + y, 0)

  const models: ModelRow[] = cats.map(c => {
    const quotes = sum(conv.qcount[c.k]), value = sum(conv.qval[c.k]), jobs = sum(conv.jcount[c.k])
    return { group: c.n || c.k, quotes, value, jobs, conv: quotes ? (100 * jobs) / quotes : null }
  }).filter(m => m.quotes > 0).sort((a, b) => b.quotes - a.quotes)

  const stateMap = new Map<string, { quotes: number; value: number }>()
  for (const p of qPoints) {
    const st = pcState(p.pc) || '?'
    const e = stateMap.get(st) || { quotes: 0, value: 0 }
    e.quotes++; e.value += Number(p.a) || 0; stateMap.set(st, e)
  }
  const states: StateRow[] = Array.from(stateMap.entries())
    .map(([state, v]) => ({ state, ...v })).sort((a, b) => b.quotes - a.quotes)

  const totQ = models.reduce((s, m) => s + m.quotes, 0)
  const totV = models.reduce((s, m) => s + m.value, 0)
  const totJ = models.reduce((s, m) => s + m.jobs, 0)

  // ── Coverage: demand nobody is near ──────────────────────────────────────
  // The reason this report exists rather than being three numbers in the sales
  // recap. Same nearest-wins rule as the Quotes Map overlay and the Conversion
  // page, so all three agree on what "in range" means.
  let coverage: MarketingReport['coverage'] = null
  if (cache?.fy) {
    const dj = await distributorJobsForFy(db, cache.fy)
    const pins: DistributorTunePin[] = dj.byDistributor || []
    if (pins.length) {
      const per = new Map<string, { quotes: number; value: number }>()
      const out = new Map<string, { state: string; quotes: number; value: number }>()
      let inQ = 0, inV = 0, outQ = 0, outV = 0
      for (const p of qPoints) {
        if (p.la == null || p.ln == null) continue
        let best: DistributorTunePin | null = null, bestKm = Infinity
        for (const d of pins) {
          const km = haversineKm(p.la, p.ln, d.lat, d.lng)
          if (km <= radiusKm && km < bestKm) { bestKm = km; best = d }
        }
        const amt = Number(p.a) || 0
        if (best) {
          inQ++; inV += amt
          const e = per.get(best.name) || { quotes: 0, value: 0 }
          e.quotes++; e.value += amt; per.set(best.name, e)
        } else {
          outQ++; outV += amt
          const label = String(p.l || 'Unknown')
          const e = out.get(label) || { state: pcState(p.pc) || '?', quotes: 0, value: 0 }
          e.quotes++; e.value += amt; out.set(label, e)
        }
      }
      coverage = {
        radiusKm,
        inside: { quotes: inQ, value: r0(inV) },
        outside: { quotes: outQ, value: r0(outV) },
        hotspots: Array.from(out.entries())
          .map(([label, v]) => ({ label, state: v.state, quotes: v.quotes, value: r0(v.value) }))
          .sort((a, b) => b.quotes - a.quotes || b.value - a.value).slice(0, 12),
        byDistributor: pins.map(d => {
          const e = per.get(d.name) || { quotes: 0, value: 0 }
          return { name: d.name, suburb: d.suburb, quotes: e.quotes, value: r0(e.value), tunes: d.jobs }
        }).sort((a, b) => b.quotes - a.quotes),
      }
      if (dj.unlocated?.tunes) {
        notes.push(`${dj.unlocated.tunes} tunes sit with distributors we hold no address for, so they have no area and are missing from the coverage figures.`)
      }
    }
  }

  return {
    week, fy: cache?.fy ?? 0, syncedAt: cache?.synced_at ?? null,
    channels, weekTotal, priorTotal,
    models, states,
    totals: { quotes: totQ, value: r0(totV), jobs: totJ, conv: totQ ? (100 * totJ) / totQ : null },
    coverage, notes,
  }
}
