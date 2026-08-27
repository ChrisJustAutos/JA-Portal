// pages/api/workshop/map/index.ts
// Read API for the Workshop Map & Conversion dashboard (Reports → Map).
// GET /api/workshop/map[?fy=2026] → the prebuilt per-FY payload the daily MD
// worker cached (md_workshop_map_cache), plus available FYs + last-sync info.
// All filtering (month / vehicle) happens client-side — this is one SELECT.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { distributorJobsForFy } from '../../../../lib/workshop-map/distributor-jobs'
import { pcState } from '../../../../lib/workshop-map/postcode-state'

export default withAuth('view:reports', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const { data: fyRows, error: fyErr } = await db.from('md_workshop_map_cache')
    .select('fy, synced_at, quote_count:payload->quotes->meta->total_quotes')
    .order('fy', { ascending: false })
  if (fyErr) return res.status(500).json({ error: fyErr.message })
  const fys = (fyRows || []).map(r => r.fy)
  if (!fys.length) {
    return res.status(200).json({ fy: null, fys: [], payload: null, synced_at: null, last_run: await lastRun(db) })
  }

  // Default FY: the newest one with a meaningful amount of data. Without this,
  // the map flips to the new FY on 1 July with a week of quotes and looks
  // broken/empty ("159 quotes all year"). A young FY takes over once it has
  // accumulated ~a month of volume; the header FY buttons switch any time.
  const MIN_QUOTES_FOR_DEFAULT = 500
  const defaultFy = (fyRows || []).find(r => Number((r as any).quote_count) >= MIN_QUOTES_FOR_DEFAULT)?.fy ?? fys[fys.length - 1]
  const wanted = Number(req.query.fy)
  const fy = fys.includes(wanted) ? wanted : defaultFy

  const { data: cache, error } = await db.from('md_workshop_map_cache')
    .select('fy, payload, synced_at').eq('fy', fy).single()
  if (error) return res.status(500).json({ error: error.message })

  // ── Comparison years ───────────────────────────────────────────────────
  // ?compare=2025,2024 returns those FYs' payloads alongside the primary one,
  // so Conversion / By State / Vehicle Trend can show several years together.
  // The maps stay single-year (overlapping dots are unreadable), so the extra
  // payloads are only ever consumed by the non-map views.
  const compareFys = String(req.query.compare || '')
    .split(',').map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && fys.includes(n) && n !== fy)
    .slice(0, 4)

  // A comparison year is sent COMPACT — the conv counts, a per-state rollup of
  // the same, and its distributor jobs. Never the points arrays: those are the
  // whole bulk of a payload (FY2026 is 2.1MB, FY2025 1.2MB), and shipping two
  // of them alongside the primary year runs at Vercel's response ceiling for a
  // view that only ever reads the counts. This keeps a comparison year at a few
  // KB while still supporting the state filter.
  const comparisons = compareFys.length
    ? await Promise.all(compareFys.map(async cfy => {
        const { data: c } = await db.from('md_workshop_map_cache')
          .select('fy, payload, synced_at').eq('fy', cfy).single()
        if (!c) return null
        const p: any = c.payload || {}
        return {
          fy: c.fy,
          synced_at: c.synced_at,
          months: p.months || [],
          conv: p.conv || { qcount: {}, qval: {}, jcount: {} },
          convByState: rollupByState(p),
          distributor_jobs: await distributorJobsForFy(db, c.fy),
        }
      }))
    : []

  res.setHeader('Cache-Control', 'private, max-age=300')
  return res.status(200).json({
    fy: cache.fy,
    fys,
    payload: cache.payload,
    synced_at: cache.synced_at,
    deposits: await depositTotals(db, fy),
    // Distributor tunes as jobs — one per VIN per month, off the Distributor
    // report's invoices (PO number = VIN). The Conversion view folds these into
    // booked jobs when the toggle is on.
    distributor_jobs: await distributorJobsForFy(db, fy),
    comparisons: comparisons.filter(Boolean),
    last_run: await lastRun(db),
  })
})

// Per-state conversion counts for a comparison year, built server-side from the
// payload's points so the client can honour the state filter WITHOUT us shipping
// the points themselves. Same shape as payload.conv, keyed by state.
function rollupByState(p: any): Record<string, { qcount: Record<string, number[]>; qval: Record<string, number[]>; jcount: Record<string, number[]> }> {
  const out: Record<string, { qcount: Record<string, number[]>; qval: Record<string, number[]>; jcount: Record<string, number[]> }> = {}
  const bucket = (stt: string) => (out[stt] ||= { qcount: {}, qval: {}, jcount: {} })
  for (const pt of (p?.quotes?.points || [])) {
    const b = bucket(pcState(pt.pc))
    ;(b.qcount[pt.g] ||= Array(12).fill(0))[pt.m]++
    ;(b.qval[pt.g] ||= Array(12).fill(0))[pt.m] += Number(pt.a) || 0
  }
  for (const pt of (p?.jobs?.points || [])) {
    const b = bucket(pcState(pt.pc))
    ;(b.jcount[pt.g] ||= Array(12).fill(0))[pt.m]++
  }
  return out
}

// Booking deposits AWAITING JOBS for the FY. The map's job totals now fold
// each customer's deposit(s) into their next completed job (build-payload —
// same attachment rule as here), so this sub-line shows only what's NOT on
// the map yet: deposits with no clear job for the customer on/after the
// deposit date within the FY. Deposit definition proven against FY2026 data:
// is_noise + description contains "deposit" catches every MD Booking Deposit
// invoice with zero false hits on real jobs (job-type LISTS mention Deposit
// on big jobs, which is why items_text must NOT be matched here).
async function depositTotals(db: SupabaseClient, fy: number) {
  // Page past PostgREST's per-request row cap.
  const fetchAll = async (build: (from: number, to: number) => any) => {
    const out: any[] = []
    for (let from = 0; ; from += 1000) {
      const { data } = await build(from, from + 999)
      if (!data?.length) break
      out.push(...data)
      if (data.length < 1000) break
    }
    return out
  }
  const deposits = await fetchAll((a, b) => db.from('md_invoices')
    .select('customer_id, month, issue_date, total_amount')
    .eq('fy', fy).eq('is_noise', true).gt('total_amount', 0)
    .ilike('description', '%deposit%').order('issue_date').range(a, b))
  // Jobs from ANY period (not fy-filtered): a June deposit earned by a July
  // job (next FY) is consumed, not "awaiting" — even though it's outside the
  // dots of both FY payloads (build-payload folds within-FY only).
  const jobs = await fetchAll((a, b) => db.from('md_invoices')
    .select('customer_id, issue_date')
    .eq('is_noise', false).gt('total_amount', 0)
    .not('customer_id', 'is', null).order('issue_date').range(a, b))

  const lastJobByCust = new Map<string, string>()
  for (const j of jobs) {
    const prev = lastJobByCust.get(j.customer_id)
    if (!prev || j.issue_date > prev) lastJobByCust.set(j.customer_id, j.issue_date)
  }

  const byMonth = Array(12).fill(0) as number[]
  let total = 0, count = 0
  for (const r of deposits) {
    // Attached to a job (a clear job exists on/after the deposit date) →
    // already inside that dot's total; skip here.
    const lastJob = r.customer_id ? lastJobByCust.get(r.customer_id) : null
    if (lastJob && r.issue_date && lastJob >= r.issue_date) continue
    const mm = Number(String(r.month || '').slice(5, 7))
    const idx = mm >= 7 ? mm - 7 : mm + 5 // FY month index, Jul=0
    const amt = Number(r.total_amount) || 0
    if (idx >= 0 && idx < 12) byMonth[idx] += amt
    total += amt; count++
  }
  return { total: Math.round(total), count, byMonth: byMonth.map(v => Math.round(v)) }
}

async function lastRun(db: SupabaseClient) {
  const { data } = await db.from('md_workshop_map_runs')
    .select('id, status, started_at, completed_at, error, invoice_count, quote_count')
    .order('started_at', { ascending: false }).limit(1).maybeSingle()
  return data || null
}
