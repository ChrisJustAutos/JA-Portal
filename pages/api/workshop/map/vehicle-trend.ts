// pages/api/workshop/map/vehicle-trend.ts
// Read API for the Vehicle Trend view (Reports → Workshop Map → Vehicle Trend).
// GET /api/workshop/map/vehicle-trend?fy=2026[&month=0..11]
//   → the fact rows for the selection, keyed (bucket, vehicle group, state),
//     plus the full bucket list the selection implies:
//       no month → the 12 FY months;  a month → every day of that month.
//
// State stays a dimension rather than a server-side filter so the view can show
// per-state pill counts and switch between them without a refetch — the same
// way the map tabs filter their points client-side.
//
// Unlike the map tabs this does NOT read md_workshop_map_cache: that payload is
// FY-monthly only, so daily buckets aren't in it. The md_vehicle_trend RPC
// (migration 196) aggregates the fact tables directly, which also means the
// trend reflects the last MD pull without waiting for a payload rebuild.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'

export interface VehicleTrendRow {
  bucket: string                // 'YYYY-MM' (monthly) or 'YYYY-MM-DD' (daily)
  group: string                 // VehicleGroup key
  state: string                 // 'QLD' | … | '?'
  jobs: number
  quotes: number
  jobValue: number
  quoteValue: number
}
export interface VehicleTrendResp {
  fy: number
  monthIdx: number | null
  granularity: 'month' | 'day'
  buckets: { k: string; label: string }[]
  rows: VehicleTrendRow[]
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// FY month index (Jul=0) → calendar year/month for the given AU FY.
function fyMonthToCal(fy: number, idx: number): { year: number; month: number } {
  return idx < 6 ? { year: fy - 1, month: 7 + idx } : { year: fy, month: idx - 5 }
}

// Every bucket the selection covers, including empty ones — the RPC only
// returns buckets with activity, and a trend line needs the gaps drawn.
function buildBuckets(fy: number, monthIdx: number | null): { k: string; label: string }[] {
  if (monthIdx == null) {
    return Array.from({ length: 12 }, (_, i) => {
      const { year, month } = fyMonthToCal(fy, i)
      return { k: `${year}-${String(month).padStart(2, '0')}`, label: `${MONTH_ABBR[month - 1]} ${String(year).slice(2)}` }
    })
  }
  const { year, month } = fyMonthToCal(fy, monthIdx)
  // Day 0 of the next month = last day of this one.
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return Array.from({ length: days }, (_, i) => {
    const d = i + 1
    return { k: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`, label: String(d) }
  })
}

export default withAuth('view:reports', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }

  const fy = Number(req.query.fy)
  if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) return res.status(400).json({ error: 'fy required' })

  const rawMonth = req.query.month
  let monthIdx: number | null = null
  if (rawMonth != null && rawMonth !== '' && rawMonth !== '-1') {
    const m = Number(rawMonth)
    if (!Number.isInteger(m) || m < 0 || m > 11) return res.status(400).json({ error: 'month must be 0-11' })
    monthIdx = m
  }

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const { data, error } = await db.rpc('md_vehicle_trend', { p_fy: fy, p_month_idx: monthIdx })
  if (error) return res.status(500).json({ error: error.message })

  const buckets = buildBuckets(fy, monthIdx)
  const known = new Set(buckets.map(b => b.k))

  const rows: VehicleTrendRow[] = []
  for (const r of (data || []) as any[]) {
    if (!known.has(r.bucket)) continue          // defensive: fact row outside the window
    rows.push({
      bucket: r.bucket,
      group: r.vehicle_group || 'OTH',
      state: r.state || '?',
      jobs: Number(r.jobs) || 0,
      quotes: Number(r.quotes) || 0,
      jobValue: Number(r.job_value) || 0,
      quoteValue: Number(r.quote_value) || 0,
    })
  }

  const resp: VehicleTrendResp = { fy, monthIdx, granularity: monthIdx == null ? 'month' : 'day', buckets, rows }
  res.setHeader('Cache-Control', 'private, max-age=300')
  return res.status(200).json(resp)
})
