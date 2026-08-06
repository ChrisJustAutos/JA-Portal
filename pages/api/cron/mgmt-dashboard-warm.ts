// pages/api/cron/mgmt-dashboard-warm.ts
// Nightly (5:30am Brisbane): recompute the Management Dashboard's MYOB source
// bundle + revenueOrdersLeads bundle with refresh forced, so the first open of
// the morning serves instantly from cache (Chris 2026-08-07). The read path's
// 26h TTL means the dashboard never blocks on MYOB during the day; the
// dashboard's Refresh button still forces a live pull on demand.
//
// Auth: Bearer CRON_SECRET, with the vercel-cron user-agent fallback.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { computeMgmtDashboard } from '../../../lib/mgmt-dashboard'

export const config = { maxDuration: 300 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase()
  const authorized = cronSecret ? authHeader === `Bearer ${cronSecret}` : userAgent.includes('vercel-cron')
  if (!authorized) return res.status(401).json({ error: 'Unauthorised' })

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const t0 = Date.now()
  try {
    const payload = await computeMgmtDashboard(db, { refresh: true })
    return res.status(200).json({
      ok: true,
      warmedInMs: Date.now() - t0,
      charts: Array.isArray((payload as any)?.charts) ? (payload as any).charts.length : null,
      generatedAt: (payload as any)?.generatedAt || null,
    })
  } catch (e: any) {
    console.error('[mgmt-dashboard-warm] failed:', e?.message || e)
    // Stale cache keeps serving (26h TTL); tomorrow's run retries.
    return res.status(500).json({ ok: false, error: (e?.message || String(e)).slice(0, 400), warmedInMs: Date.now() - t0 })
  }
}
