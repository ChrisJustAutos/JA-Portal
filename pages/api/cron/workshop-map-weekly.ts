// pages/api/cron/workshop-map-weekly.ts
//
// Monday-morning quotes & jobs geography report (lib/workshop-map-weekly-report.ts):
// aggregates last week's quote/job locations + vehicle mix from md_quotes /
// md_invoices, has Claude write the "what it means / where to market" read,
// and EMAILS it to Matt (cc Ryan + Chris) with a link to Reports → Workshop Map.
// Recipients via WORKSHOP_MAP_REPORT_TO / _CC env overrides.
//
// Schedule (vercel.json): Sunday 21:10 UTC = Monday 7:10am AEST (just after
// the calls coaching report).
//   ?dry=1     build the report and return the JSON without posting
//   ?days=N    widen/narrow the window (default 7)
//
// Auth: Authorization: Bearer $CRON_SECRET, or a logged-in staffer with
// view:reports (manual previews / re-runs need no secret).

import type { NextApiRequest, NextApiResponse } from 'next'
import { runMapWeeklyReport } from '../../../lib/workshop-map-weekly-report'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

export const config = { maxDuration: 300 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const bearerOk = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`
  if (!bearerOk) {
    const user = await getCurrentUser(req)
    if (!user || !roleHasPermission(user.role, 'view:reports')) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  try {
    const result = await runMapWeeklyReport({
      dryRun: req.query.dry === '1',
      days: req.query.days ? Number(req.query.days) : undefined,
    })
    return res.status(200).json({ ok: true, ...result })
  } catch (e: any) {
    console.error('[workshop-map-weekly] failed:', e?.message || e)
    return res.status(500).json({ ok: false, error: (e?.message || String(e)).slice(0, 500) })
  }
}
