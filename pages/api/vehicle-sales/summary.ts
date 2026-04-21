// pages/api/vehicle-sales/summary.ts
// Reads cached VPS invoice classifications from Supabase — no live MYOB hit.
// The cache is populated by /api/vehicle-sales/sync (manual or scheduled).
//
// Query params:
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD  (defaults to current FY → today)

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../../../lib/auth'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

function todayISOBrisbane(): string {
  const nowUtc = new Date()
  const bris = new Date(nowUtc.getTime() + 10 * 3600 * 1000)
  return `${bris.getUTCFullYear()}-${String(bris.getUTCMonth() + 1).padStart(2, '0')}-${String(bris.getUTCDate()).padStart(2, '0')}`
}

function startOfFYISO(): string {
  const t = todayISOBrisbane()
  const [y, m] = t.split('-').map(Number)
  const fyStartYear = m >= 7 ? y : y - 1
  return `${fyStartYear}-07-01`
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function monthLabel(key: string): string {
  const [y, m] = key.split('-')
  return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`
}

function isoOrDefault(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return fallback
  return raw
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.status(405).end(); return }
  return requireAuth(req, res, async () => {
    try {
      const from = isoOrDefault(req.query.from, startOfFYISO())
      const to   = isoOrDefault(req.query.to,   todayISOBrisbane())

      // Sync state header so the UI can show freshness.
      const { data: syncState } = await sb()
        .from('myob_vps_sync_state')
        .select('last_sync_at, last_invoice_date_synced, invoices_classified, last_sync_duration_ms, last_error')
        .eq('id', 1)
        .maybeSingle()

      // Fetch all classifications in window. We paginate because Supabase
      // default row limit is 1000 and FY has ~2200 VPS invoices.
      let allRows: any[] = []
      const pageSize = 1000
      let offset = 0
      for (;;) {
        const { data, error } = await sb()
          .from('myob_vps_invoice_classifications')
          .select('invoice_id, invoice_number, invoice_date, customer_name, total_ex_gst, platforms_detected, classification')
          .gte('invoice_date', from)
          .lte('invoice_date', to)
          .range(offset, offset + pageSize - 1)
          .order('invoice_date', { ascending: true })
        if (error) throw new Error(error.message)
        if (!data || data.length === 0) break
        allRows = allRows.concat(data)
        if (data.length < pageSize) break
        offset += pageSize
      }

      const summary = {
        invoice_count: 0, total_ex_gst: 0,
        classified_count: 0, classified_total: 0,
        unclassified_count: 0, unclassified_total: 0,
        mixed_count: 0, mixed_total: 0,
      }
      const byPlatform = new Map<string, { key: string; label: string; total: number; invoice_count: number }>()
      const byMonth = new Map<string, {
        key: string; label: string; total: number; invoice_count: number;
        platforms: Map<string, { total: number; invoice_count: number }>;
      }>()

      for (const row of allRows) {
        const amount = Number(row.total_ex_gst || 0)
        if (amount <= 0) continue
        const plat: string = row.classification || 'Unclassified'
        const monthKey = String(row.invoice_date).substring(0, 7)

        summary.invoice_count++
        summary.total_ex_gst += amount

        if (plat === 'Unclassified') {
          summary.unclassified_count++
          summary.unclassified_total += amount
        } else if (plat === 'Mixed') {
          summary.mixed_count++
          summary.mixed_total += amount
          summary.classified_count++
          summary.classified_total += amount
        } else {
          summary.classified_count++
          summary.classified_total += amount
        }

        if (!byPlatform.has(plat)) byPlatform.set(plat, { key: plat, label: plat, total: 0, invoice_count: 0 })
        const pb = byPlatform.get(plat)!
        pb.total += amount
        pb.invoice_count++

        if (!byMonth.has(monthKey)) {
          byMonth.set(monthKey, { key: monthKey, label: monthLabel(monthKey), total: 0, invoice_count: 0, platforms: new Map() })
        }
        const mb = byMonth.get(monthKey)!
        mb.total += amount
        mb.invoice_count++
        if (!mb.platforms.has(plat)) mb.platforms.set(plat, { total: 0, invoice_count: 0 })
        const mp = mb.platforms.get(plat)!
        mp.total += amount
        mp.invoice_count++
      }

      const round2 = (n: number) => Math.round(n * 100) / 100
      summary.total_ex_gst       = round2(summary.total_ex_gst)
      summary.classified_total   = round2(summary.classified_total)
      summary.unclassified_total = round2(summary.unclassified_total)
      summary.mixed_total        = round2(summary.mixed_total)

      const byPlatformArr = Array.from(byPlatform.values())
        .map(p => ({ ...p, total: round2(p.total) }))
        .sort((a, b) => b.total - a.total)

      const byMonthArr = Array.from(byMonth.values())
        .map(m => ({
          key: m.key, label: m.label,
          total: round2(m.total), invoice_count: m.invoice_count,
          platforms: Array.from(m.platforms.entries())
            .map(([k, v]) => ({ key: k, label: k, total: round2(v.total), invoice_count: v.invoice_count }))
            .sort((a, b) => b.total - a.total),
        }))
        .sort((a, b) => a.key.localeCompare(b.key))

      res.status(200).json({
        period: { from, to },
        sync_state: syncState || null,
        summary,
        by_platform: byPlatformArr,
        by_month: byMonthArr,
      })
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Unknown' })
    }
  })
}
