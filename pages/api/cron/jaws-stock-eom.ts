// pages/api/cron/jaws-stock-eom.ts
//
// Month-end JAWS stock report: builds the month just ended, stores the snapshot
// (migration 199 — the stored history is what makes month-on-month comparison
// possible at all, since AccountRight only ever reports today's quantity), and
// emails it to the JAWS_EOM_EMAIL_TO list.
//
// Scheduled 21:30 UTC on the 1st = 07:30 Brisbane on the 2nd. Cron can't express
// "last day of the month", and running a few hours into the new month keeps the
// on-hand read close to the month boundary while guaranteeing the month's
// invoices are all in.
//
// ?month=YYYY-MM re-runs a specific month. Auth: Bearer $CRON_SECRET.

import type { NextApiRequest, NextApiResponse } from 'next'
import { buildEomReport, saveSnapshot, previousMonth, emailEomReport } from '../../../lib/jaws-stock-eom'

export const config = { maxDuration: 300 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ok = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`
  if (!ok) return res.status(401).json({ error: 'Unauthorized' })

  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || ''))
    ? String(req.query.month) : previousMonth()

  try {
    const rep = await buildEomReport(month)
    await saveSnapshot(rep, null)
    const emailed = await emailEomReport(rep)
    console.log(`[jaws-stock-eom] ${month}: stock ${rep.headline.stockValue}, margin ${rep.headline.monthMargin}, emailed ${emailed.join(', ')}`)
    return res.status(200).json({
      ok: true, month,
      stockValue: rep.headline.stockValue,
      monthRevenueEx: rep.headline.monthRevenueEx,
      monthMargin: rep.headline.monthMargin,
      reorderCount: rep.headline.reorderCount,
      emailed,
    })
  } catch (e: any) {
    console.error('[jaws-stock-eom] failed:', e?.message || e)
    return res.status(500).json({ ok: false, error: (e?.message || String(e)).slice(0, 300) })
  }
}
