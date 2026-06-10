// pages/api/cron/workshop-reminders.ts
// Vercel cron — drains the workshop_reminders queue (booking reminders etc.)
// and sends due ones via ClickSend. Auto sends only fire when
// workshop_settings.sms_enabled is true. Auth: CRON_SECRET bearer (or the
// vercel-cron user-agent), mirroring the other crons.

import { NextApiRequest, NextApiResponse } from 'next'
import { processDueReminders, queueServiceDueReminders } from '../../../lib/workshop-reminders'

export const config = { maxDuration: 60 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase()
  const authorized = cronSecret ? authHeader === `Bearer ${cronSecret}` : userAgent.includes('vercel-cron')
  if (!authorized) return res.status(401).json({ error: 'Unauthorised' })

  try {
    const dueQueued = await queueServiceDueReminders(100).catch(() => ({ service_queued: 0, rego_queued: 0 }))
    const result = await processDueReminders(100)
    return res.status(200).json({ ok: true, ...dueQueued, ...result })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
}
