// pages/api/cron/b2b-reminders.ts
// The three B2B nudges — abandoned carts (24h + 72h), checkouts that were
// started and never paid (once at 24h), and paid orders we haven't shipped
// (2 days, escalating at 5). Logic lives in lib/b2b-reminders.ts.
//
// Runs every 3 hours: often enough that "24 hours" means roughly that, rare
// enough that it costs nothing. Every pass is idempotent, so an extra run
// sends nothing twice.
//
// Auth: Bearer CRON_SECRET, with the vercel-cron user-agent fallback.
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/b2b-reminders

import type { NextApiRequest, NextApiResponse } from 'next'
import { runB2bReminders } from '../../../lib/b2b-reminders'

export const config = { maxDuration: 120 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase()
  const authorized = cronSecret ? authHeader === `Bearer ${cronSecret}` : userAgent.includes('vercel-cron')
  if (!authorized) return res.status(401).json({ error: 'Unauthorised' })

  try {
    const run = await runB2bReminders()
    return res.status(200).json({ ok: true, ...run })
  } catch (e: any) {
    console.error('b2b-reminders cron failed:', e?.message || e)
    return res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
}
