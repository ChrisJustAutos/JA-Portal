// pages/api/cron/tune-jobs.ts
// Hourly: scan the accounts inbox for new Stripe tune receipts. On Monday
// mornings (Brisbane) the same run also sends the weekly "fill in your
// customer details" reminders to distributors with outstanding jobs.
//
// Auth: Bearer CRON_SECRET, with the vercel-cron user-agent fallback.

import type { NextApiRequest, NextApiResponse } from 'next'
import { ingestTuneJobEmails, sendTuneJobReminders, escalateTuneJobs, sweepTuneFollowupLetters, sendDelayedTuneJobNotices } from '../../../lib/b2b-tune-jobs'

export const config = { maxDuration: 300 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase()
  const authorized = cronSecret ? authHeader === `Bearer ${cronSecret}` : userAgent.includes('vercel-cron')
  if (!authorized) return res.status(401).json({ error: 'Unauthorised' })

  const ingest = await ingestTuneJobEmails({ lookbackDays: 7 })

  // Per-tune "fill in the details" notices fire once a job clears the 3-day
  // portal-visibility delay (Chris 2026-08-05) — not at ingest.
  const delayedNotices = await sendDelayedTuneJobNotices().catch(e => ({ notified: 0, error: String(e?.message || e) }))

  // End-of-week summary: Friday 8am-ish Brisbane (Chris 2026-07-30). No
  // global kill-switch any more — per-distributor gating instead: emails only
  // go to distributors with at least one logged-in portal user (see
  // distributorNotifiableEmails), so nothing sends until a distributor has
  // actually started using the portal. Manual sends still work: ?remind=1 or
  // the admin "Send reminders now" button.
  const autoChase = process.env.TUNE_JOBS_REMINDERS_AUTO === '1'
  let reminders: { distributors: number; jobs: number } | null = null
  const bris = new Date(Date.now() + 10 * 3600_000)
  const isFridayMorning = bris.getUTCDay() === 5 && bris.getUTCHours() === 8
  if (isFridayMorning || req.query.remind === '1') {
    reminders = await sendTuneJobReminders()
  }

  // Escalation ladder (SMS → Ryan) stays behind TUNE_JOBS_REMINDERS_AUTO —
  // a manual reminder test shouldn't arm SMSes that fire 7 days later.
  let escalation: { smsDistributors: number; escalatedJobs: number } | null = null
  if (autoChase) escalation = await escalateTuneJobs()

  // Address-less letters: once the sales advisor fills the Monday item's
  // Address column and marks the call done, the letter automation fires.
  const letterSweep = await sweepTuneFollowupLetters().catch(e => ({ checked: 0, lettersQueued: 0, errors: [String(e?.message || e)] }))

  return res.status(200).json({ ok: true, ingest, delayedNotices, reminders, escalation, autoChase, letterSweep })
}
