// pages/api/reports/jaws-stock-eom.ts
// Reports → Stock EOM (JAWS month-end stock report, lib/jaws-stock-eom).
//
//   GET  ?month=YYYY-MM        → stored snapshot if there is one, else built live
//        &refresh=1            → rebuild from MYOB and overwrite the snapshot
//   POST { month, email:true } → rebuild, store, and send the month-end email
//
// Requires BOTH view:reports and view:stock — the report carries costs, margins
// and supplier pricing, so a reports-only login (marketing) must not see it.

import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import {
  buildEomReport, saveSnapshot, loadSnapshot, listSnapshotMonths,
  previousMonth, emailEomReport,
} from '../../../lib/jaws-stock-eom'

// A full rebuild reads 13 months of invoice lines out of AccountRight.
export const config = { maxDuration: 300 }

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export default withAuth('view:reports', async (req, res, user) => {
  if (!roleHasPermission(user.role, 'view:stock')) {
    return res.status(403).json({ error: 'This report includes costs and margins — needs stock access.' })
  }

  const month = String(req.query.month || (req.body && (req.body as any).month) || previousMonth())
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' })

  try {
    if (req.method === 'GET') {
      const refresh = String(req.query.refresh || '') === '1'
      const months = await listSnapshotMonths()
      if (!refresh) {
        const stored = await loadSnapshot(month)
        if (stored) return res.status(200).json({ report: stored, months, source: 'snapshot' })
      }
      const rep = await buildEomReport(month)
      await saveSnapshot(rep, user.id)
      return res.status(200).json({ report: rep, months: await listSnapshotMonths(), source: 'rebuilt' })
    }

    if (req.method === 'POST') {
      let body: any = {}
      try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
      catch { return res.status(400).json({ error: 'Bad JSON body' }) }
      const rep = await buildEomReport(month)
      await saveSnapshot(rep, user.id)
      let emailed: string[] = []
      if (body.email) emailed = await emailEomReport(rep)
      return res.status(200).json({ report: rep, emailed, months: await listSnapshotMonths() })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (e: any) {
    console.error('[jaws-stock-eom] failed:', e?.message || e)
    return res.status(500).json({ error: (e?.message || String(e)).slice(0, 400) })
  }
})
