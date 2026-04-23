// pages/api/distributors/refresh-cache.ts
// Vercel Cron endpoint — refreshes distributors_cache for predefined ranges
// so the distributors page is instant at the start of each business day.
//
// Scheduled via vercel.json at 16:00 UTC (02:00 AEST) daily.
// Secured via CRON_SECRET — only requests with the matching header are accepted,
// so nobody can force expensive recomputes by hitting the URL directly.
//
// What gets refreshed:
//   - FY2025 (2024-07-01 → 2025-06-30)
//   - FY2026 (2025-07-01 → 2026-06-30)
//   - Each month for the last 13 months (covers current FY + a bit)
//
// If a compute fails for one range, the others still run — partial progress
// is acceptable and the next day's run will retry.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { computeDistributorsPayload, classifyRangeKey } from '../distributors'

export const config = { maxDuration: 300 }   // up to 5 minutes (Vercel cron max)

interface RangeSpec { start: string; end: string; label: string }

function lastDayOfMonth(year: number, monthOneBased: number): number {
  return new Date(Date.UTC(year, monthOneBased, 0)).getUTCDate()
}

function getRangesToRefresh(now = new Date()): RangeSpec[] {
  const ranges: RangeSpec[] = []

  // Financial years
  ranges.push({ start: '2024-07-01', end: '2025-06-30', label: 'FY2025' })
  ranges.push({ start: '2025-07-01', end: '2026-06-30', label: 'FY2026' })

  // Last 13 months (including current)
  for (let i = 0; i < 13; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    const year = d.getUTCFullYear()
    const month = d.getUTCMonth() + 1   // 1-indexed
    const mm = String(month).padStart(2, '0')
    const lastDay = lastDayOfMonth(year, month)
    ranges.push({
      start: `${year}-${mm}-01`,
      end: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
      label: `${year}-${mm}`,
    })
  }

  return ranges
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Security: only Vercel Cron can call this. Vercel sets an Authorization
  // header with 'Bearer <CRON_SECRET>' when invoking scheduled functions.
  const expected = process.env.CRON_SECRET
  const auth = req.headers.authorization || ''
  if (!expected) {
    return res.status(500).json({ error: 'CRON_SECRET not configured in Vercel env vars' })
  }
  if (auth !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return res.status(500).json({ error: 'Supabase env vars not configured' })
  }
  const sb = createClient(url, key, { auth: { persistSession: false } })

  const ranges = getRangesToRefresh()
  const results: Array<{ label: string; ok: boolean; ms?: number; err?: string }> = []

  for (const r of ranges) {
    const t0 = Date.now()
    try {
      const payload = await computeDistributorsPayload(r.start, r.end)
      const ms = Date.now() - t0
      const row = {
        range_key: classifyRangeKey(r.start, r.end),
        start_date: r.start,
        end_date: r.end,
        payload,
        invoice_count: payload?.totals?.invoiceCount ?? 0,
        config_source: payload?.configSource ?? 'fallback',
        computed_at: new Date().toISOString(),
        computed_ms: ms,
      }
      const { error } = await sb
        .from('distributors_cache')
        .upsert(row, { onConflict: 'start_date,end_date' })
      if (error) throw error
      results.push({ label: r.label, ok: true, ms })
    } catch (e: any) {
      const ms = Date.now() - t0
      console.error(`[refresh-cache] ${r.label} FAILED after ${ms}ms:`, e?.message)
      results.push({ label: r.label, ok: false, ms, err: e?.message || String(e) })
      // continue with the next range
    }
  }

  const ok = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length
  console.log(`[refresh-cache] completed: ${ok} ok, ${failed} failed`)

  return res.status(200).json({
    refreshedAt: new Date().toISOString(),
    summary: { total: results.length, ok, failed },
    results,
  })
}
