// pages/api/reports/marketing/preview.ts
//
// Renders the Weekly Marketing Report in the browser. READ-ONLY and it NEVER
// emails — the send is a separate endpoint that does not exist until Chris has
// seen this and said yes. A weekly email to a colleague is outward-facing, so
// it gets looked at before it goes anywhere (Chris 2026-09-02).
//
//   GET /api/reports/marketing/preview                 → the HTML
//   GET /api/reports/marketing/preview?format=json     → the underlying figures
//   GET /api/reports/marketing/preview?radius=100      → different coverage radius
//   GET /api/reports/marketing/preview?week=2026-08-25 → pretend it is that Monday

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { buildMarketingReport } from '../../../../lib/marketing-report'
import { renderMarketingHtml } from '../../../../lib/marketing-report-html'

export const config = { maxDuration: 120 }

export default withAuth('view:reports', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const radius = Number(req.query.radius)
  // ?week= is an "as if it were this date" knob for checking a quiet week, not
  // a range: the report always covers the trading week before the date given.
  const asOf = req.query.week ? Date.parse(`${String(req.query.week)}T09:00:00+10:00`) : Date.now()

  try {
    const report = await buildMarketingReport(db, {
      nowMs: Number.isFinite(asOf) ? asOf : Date.now(),
      radiusKm: Number.isFinite(radius) && radius > 0 ? radius : undefined,
    })
    if (String(req.query.format) === 'json') return res.status(200).json(report)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    return res.status(200).send(renderMarketingHtml(report))
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Failed to build the report' })
  }
})
