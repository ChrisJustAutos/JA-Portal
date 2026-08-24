// pages/api/reports/jaws-stock-eom.ts
// Reports → Stock EOM (JAWS month-end stock report, lib/jaws-stock-eom).
//
//   GET  ?month=YYYY-MM        → stored snapshot if there is one, else built live
//        &from=YYYY-MM&to=…    → sales-history window for the averages, months
//                                of cover and the growth read (default: the 12
//                                months ending with the reported month). A
//                                window the stored snapshot wasn't built with
//                                forces a rebuild — otherwise the screen would
//                                silently show figures for a different window.
//        &refresh=1            → rebuild from MYOB and overwrite the snapshot
//   POST { month, from, to, email:true } → rebuild, store, and send the email
//
// Requires BOTH view:reports and view:stock — the report carries costs, margins
// and supplier pricing, so a reports-only login (marketing) must not see it.

import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import {
  buildEomReport, saveSnapshot, loadSnapshot, listSnapshotMonths,
  previousMonth, emailEomReport, resolveHistoryWindow,
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

  const q = (k: string) => {
    const v = req.query[k] ?? (req.body && (req.body as any)[k])
    return v == null || v === '' ? null : String(v)
  }
  const from = q('from'), to = q('to')
  if ((from && !MONTH_RE.test(from)) || (to && !MONTH_RE.test(to))) {
    return res.status(400).json({ error: 'from/to must be YYYY-MM' })
  }
  // Resolve here too, so "does the stored snapshot match?" compares the window
  // that would actually be built, not the raw query string.
  const want = resolveHistoryWindow(month, from, to)

  try {
    if (req.method === 'GET') {
      const refresh = String(req.query.refresh || '') === '1'
      const months = await listSnapshotMonths()
      if (!refresh) {
        const stored = await loadSnapshot(month)
        // Snapshots written before the window shipped have no `history` block;
        // reuse those only when the caller didn't ask for a specific window.
        const storedWindow = stored?.history ? `${stored.history.from}:${stored.history.to}` : null
        const matches = stored && (
          (!from && !to && (!storedWindow || storedWindow === `${want.from}:${want.to}`)) ||
          storedWindow === `${want.from}:${want.to}`
        )
        if (stored && matches) return res.status(200).json({ report: stored, months, source: 'snapshot' })
      }
      const rep = await buildEomReport(month, { historyFrom: from, historyTo: to })
      await saveSnapshot(rep, user.id)
      return res.status(200).json({ report: rep, months: await listSnapshotMonths(), source: 'rebuilt' })
    }

    if (req.method === 'POST') {
      let body: any = {}
      try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
      catch { return res.status(400).json({ error: 'Bad JSON body' }) }
      const rep = await buildEomReport(month, { historyFrom: from, historyTo: to })
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
