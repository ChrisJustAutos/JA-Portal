// pages/api/cron/letter-watch.ts
//
// Hourly: poll MYOB (VPS) Sale Invoices via the portal's OAuth connection and
// queue a thank-you letter + DL envelope for each NEW finalised job invoice
// (income 4-xxxx lines). Pure booking deposits (1-1230 Customer Deposits only)
// are skipped. Dedup (workshop_letter_jobs by MYOB UID) → hourly runs are
// near-real-time but never double-print.
//
// Schedule (vercel.json): top of every hour. ?dry=1 reports what WOULD print
// without queuing. ?lookbackDays=N widens the rolling window (default 7).
//
// Auth: Authorization: Bearer $CRON_SECRET (Vercel cron sends this automatically).

import type { NextApiRequest, NextApiResponse } from 'next'
import { runLetterWatch } from '../../../lib/workshop-letter-watch'

export const config = { maxDuration: 120 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const dry = req.query.dry === '1'
  try {
    const lookbackDays = req.query.lookbackDays ? Number(req.query.lookbackDays) : undefined
    const outcome = await runLetterWatch({ dryRun: dry, lookbackDays })
    return res.status(200).json({ ok: true, dryRun: dry, ...outcome })
  } catch (e: any) {
    console.error('[letter-watch] failed:', e?.message || e)
    return res.status(500).json({ ok: false, error: (e?.message || String(e)).slice(0, 500) })
  }
}
