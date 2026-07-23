// pages/api/cron/tune-jobs.ts
// Hourly: scan the accounts inbox for new Stripe tune receipts. On Monday
// mornings (Brisbane) the same run also sends the weekly "fill in your
// customer details" reminders to distributors with outstanding jobs.
//
// Auth: Bearer CRON_SECRET, with the vercel-cron user-agent fallback.

import type { NextApiRequest, NextApiResponse } from 'next'
import { ingestTuneJobEmails, sendTuneJobReminders, escalateTuneJobs } from '../../../lib/b2b-tune-jobs'

export const config = { maxDuration: 300 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase()
  const authorized = cronSecret ? authHeader === `Bearer ${cronSecret}` : userAgent.includes('vercel-cron')
  if (!authorized) return res.status(401).json({ error: 'Unauthorised' })

  const ingest = await ingestTuneJobEmails({ lookbackDays: 7 })

  // Weekly reminders: Monday 8am-ish Brisbane (22:00 UTC Sunday). The cron
  // fires hourly; gate on Brisbane local Monday 8-9am, or force via ?remind=1.
  let reminders: { distributors: number; jobs: number } | null = null
  const bris = new Date(Date.now() + 10 * 3600_000)
  const isMondayMorning = bris.getUTCDay() === 1 && bris.getUTCHours() === 8
  if (isMondayMorning || req.query.remind === '1') {
    reminders = await sendTuneJobReminders()
  }

  // Escalation ladder runs every tick — stage stamps + the Brisbane
  // business-hours gate inside decide what actually fires.
  const escalation = await escalateTuneJobs()

  return res.status(200).json({ ok: true, ingest, reminders, escalation })
}
