// pages/api/workshop/map/pdf.ts
// GET ?fy=2026[&cat=70&state=QLD] → the Workshop Map report as a PDF download.
//
// Serves the same cached per-FY payload the dashboard reads (md_workshop_map_cache),
// so the PDF always matches the screen and returns in about a second — there is
// no live MechanicDesk pull behind this button.
//
// Deliberately NOT month-filtered: the screen already shows one month at a time,
// and the point of the export is to carry the whole year away month by month.
// The vehicle and state filters DO carry through, because those narrow which
// records belong in the report rather than which period.
//
// Same gate as the read API it mirrors: view:reports.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { renderWorkshopMapPdf, workshopMapPdfFilename } from '../../../../lib/workshop-map-pdf'
import type { MapPdfPayload } from '../../../../lib/workshop-map-pdf'

export const config = { maxDuration: 60 }

export default withAuth('view:reports', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  try {
    const wanted = Number(req.query.fy)
    const { data: fyRows, error: fyErr } = await db.from('md_workshop_map_cache')
      .select('fy').order('fy', { ascending: false })
    if (fyErr) return res.status(500).json({ error: fyErr.message })
    const fys = (fyRows || []).map(r => r.fy)
    if (!fys.length) return res.status(404).json({ error: 'No workshop-map data yet — the daily MechanicDesk pull has not run.' })
    const fy = fys.includes(wanted) ? wanted : fys[0]

    const { data: cache, error } = await db.from('md_workshop_map_cache')
      .select('fy, payload, synced_at').eq('fy', fy).single()
    if (error) return res.status(500).json({ error: error.message })
    const payload = cache?.payload as MapPdfPayload | null
    if (!payload) return res.status(404).json({ error: `No cached payload for FY${fy}.` })

    const cat = req.query.cat ? String(req.query.cat) : 'all'
    const state = req.query.state ? String(req.query.state) : 'all'
    const opts = {
      cat, state,
      syncedAt: cache.synced_at as string | null,
      // Deposits are a whole-FY figure; they carry no vehicle or postcode, so a
      // filtered report leaves them out rather than showing an unrelated total.
      deposits: cat === 'all' && state === 'all' ? await depositTotals(db, fy) : null,
    }

    const buffer = await renderWorkshopMapPdf(payload, opts)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${workshopMapPdfFilename(payload, opts)}"`)
    res.setHeader('Content-Length', String(buffer.length))
    return res.status(200).send(buffer)
  } catch (e: any) {
    console.error('[workshop/map/pdf] failed:', e?.message || e)
    return res.status(500).json({ error: (e?.message || String(e)).slice(0, 400) })
  }
})

// Booking deposits AWAITING JOBS — same rule as the read API in ./index.ts:
// a deposit whose customer has a completed job on/after the deposit date is
// already inside that customer's dot, so only the unconsumed ones count here.
async function depositTotals(db: SupabaseClient, fy: number) {
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
  const deposits = await fetchAll((a: number, b: number) => db.from('md_invoices')
    .select('customer_id, month, issue_date, total_amount')
    .eq('fy', fy).eq('is_noise', true).gt('total_amount', 0)
    .ilike('description', '%deposit%').order('issue_date').range(a, b))
  const jobs = await fetchAll((a: number, b: number) => db.from('md_invoices')
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
