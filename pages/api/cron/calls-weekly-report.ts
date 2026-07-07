// pages/api/cron/calls-weekly-report.ts
//
// Monday-morning sales coaching report (see lib/calls-weekly-report.ts):
// aggregates last week's coached calls per advisor, writes the narrative with
// Claude, and posts team overview + per-advisor threads to #sales-coaching.
//
// Schedule (vercel.json): Sunday 21:00 UTC = Monday 7:00am AEST.
//   ?dry=1     build the report and return the JSON without posting
//   ?days=N    widen/narrow the window (default 7)
//
// Auth: Authorization: Bearer $CRON_SECRET, or a logged-in staffer with
// view:calls (manual previews / re-runs need no secret).

import type { NextApiRequest, NextApiResponse } from 'next'
import { runWeeklyReport } from '../../../lib/calls-weekly-report'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

export const config = { maxDuration: 300 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const bearerOk = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`
  if (!bearerOk) {
    const user = await getCurrentUser(req)
    if (!user || !roleHasPermission(user.role, 'view:calls')) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  try {
    const result = await runWeeklyReport({
      dryRun: req.query.dry === '1',
      days: req.query.days ? Number(req.query.days) : undefined,
    })
    return res.status(200).json({ ok: true, ...result })
  } catch (e: any) {
    console.error('[calls-weekly-report] failed:', e?.message || e)
    return res.status(500).json({ ok: false, error: (e?.message || String(e)).slice(0, 500) })
  }
}
