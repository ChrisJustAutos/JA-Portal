// pages/api/cron/tune-jobs.ts
// Hourly: scan the accounts inbox for new Stripe tune receipts. Once a week it
// also sends the "fill in your customer details" reminders to distributors with
// outstanding jobs, plus the internal recap to Matt.
//
// The weekly block used to fire only in the single run where Brisbane time was
// Friday 08:xx. Miss that one run and the whole week's chasing and recap were
// skipped silently, with no retry and nobody told - which is exactly what
// happened on 2026-08-28 (see below). It is now a WINDOW plus a marker: any run
// from Friday 08:00 Brisbane through Sunday will do it, and the marker (that
// Friday's Brisbane date, in app_settings) makes sure it happens once.
//
// Auth: Bearer CRON_SECRET, with the vercel-cron user-agent fallback.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { ingestTuneJobEmails, sendTuneJobReminders, sendTuneJobRecap, escalateTuneJobs, sweepTuneFollowupLetters, sendDelayedTuneJobNotices, requeueBrokenTuneLetters, backfillTuneAddressColumns } from '../../../lib/b2b-tune-jobs'

export const config = { maxDuration: 300 }

// Records which Friday's weekly chase has been done, so the run can be retried
// through the weekend without repeating it.
const WEEKLY_MARKER_KEY = 'tune_jobs_weekly_chase_friday'

let _sbs: SupabaseClient | null = null
function sbSettings(): SupabaseClient {
  if (_sbs) return _sbs
  _sbs = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sbs
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase()
  const authorized = cronSecret ? authHeader === `Bearer ${cronSecret}` : userAgent.includes('vercel-cron')
  if (!authorized) return res.status(401).json({ error: 'Unauthorised' })

  // Guarded like every other step: an unguarded throw here 500s the whole
  // handler, so a Graph hiccup would take the weekly reminders down with it.
  const ingest = await ingestTuneJobEmails({ lookbackDays: 7 })
    .catch(e => ({ error: String(e?.message || e) }) as any)

  // One-shot (marker-guarded): reprint the 2026-08-05/06 letters that went
  // out with a literal {{business_name}} token.
  const letterRepair = await requeueBrokenTuneLetters().catch(e => ({ requeued: 0, skipped: false, errors: [String(e?.message || e)] }))

  // Fill the Monday Address (location) column where the submission carried an
  // address but the item's column is still empty (geocoded via Nominatim).
  const addressBackfill = await backfillTuneAddressColumns().catch(e => ({ checked: 0, filled: 0, errors: [String(e?.message || e)] }))

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
  let recap: { sent: boolean; rows: number } | null = null

  // Brisbane is UTC+10 year round (no DST), so shifting the clock is enough.
  const bris = new Date(Date.now() + 10 * 3600_000)
  // Days since the most recent Friday: Fri 0, Sat 1, Sun 2, Mon 3 ... Thu 6.
  // Deliberately NOT a `getUTCDay() >= 5` test - Sunday is 0, so that form
  // silently drops the last day of the catch-up window.
  const daysSinceFriday = (bris.getUTCDay() - 5 + 7) % 7
  const fridayKey = new Date(bris.getTime() - daysSinceFriday * 86_400_000).toISOString().slice(0, 10)
  // Friday from 08:00 Brisbane, through Saturday and Sunday. Monday starts a
  // new week: a week that was missed entirely is not silently chased late.
  const inWeeklyWindow = daysSinceFriday <= 2 && (daysSinceFriday > 0 || bris.getUTCHours() >= 8)
  const forced = req.query.remind === '1'

  let alreadyDone: string | null = null
  if (inWeeklyWindow && !forced) {
    const { data } = await sbSettings().from('app_settings')
      .select('value').eq('key', WEEKLY_MARKER_KEY).maybeSingle()
    alreadyDone = data?.value ? String(data.value) : null
  }

  if (forced || (inWeeklyWindow && alreadyDone !== fridayKey)) {
    // Safe to re-enter: sendTuneJobReminders only picks jobs whose
    // last_reminder_at is null or older than 6.5 days, so a retry after a
    // failure cannot chase the same distributor twice in a week.
    reminders = await sendTuneJobReminders()
    // Internal wrap-up to Matt once the chasing is done: every distributor's
    // outstanding count, oldest job and value, including the ones that were
    // NOT chased because nobody there has logged in.
    recap = await sendTuneJobRecap(reminders).catch(e => {
      console.error('tune-job recap email failed (non-fatal):', e?.message || e)
      return null
    })
    // Mark the week done only once BOTH halves are out. If the recap failed,
    // the next hourly run retries it - and the reminders it re-runs alongside
    // will send nothing new. That is the whole point: one bad run no longer
    // costs a week.
    if (!forced && reminders && recap?.sent) {
      await sbSettings().from('app_settings').upsert({
        key: WEEKLY_MARKER_KEY, value: fridayKey as any, updated_at: new Date().toISOString(),
      }, { onConflict: 'key' })
    }
  }

  // Escalation ladder (SMS → Ryan) stays behind TUNE_JOBS_REMINDERS_AUTO —
  // a manual reminder test shouldn't arm SMSes that fire 7 days later.
  let escalation: { smsDistributors: number; escalatedJobs: number } | null = null
  if (autoChase) escalation = await escalateTuneJobs()

  // Address-less letters: once the sales advisor fills the Monday item's
  // Address column and marks the call done, the letter automation fires.
  const letterSweep = await sweepTuneFollowupLetters().catch(e => ({ checked: 0, lettersQueued: 0, errors: [String(e?.message || e)] }))

  return res.status(200).json({ ok: true, ingest, letterRepair, addressBackfill, delayedNotices, reminders, recap, weeklyWindow: { inWeeklyWindow, fridayKey, alreadyDone, forced }, escalation, autoChase, letterSweep })
}
