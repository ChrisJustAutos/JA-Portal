// pages/api/cron/calls-daily-recap.ts
// 6:00pm Brisbane: one coaching recap for the day into #sales-coaching,
// replacing the ~120 per-call cards (Chris, 2026-08-31).
//
// Hourly from 18:00 to 21:00 Brisbane with a date marker, not a single daily
// slot — a once-a-day cron that lands on a deploy is skipped silently, which
// is what cost the tune-job chase a whole week earlier today.
//
// Auth: Bearer CRON_SECRET, with the vercel-cron user-agent fallback.
//   ?send=1 forces a post regardless of time/marker (manual catch-up).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { postDailyRecap, brisbaneDayWindow } from '../../../lib/calls-daily-recap'

export const config = { maxDuration: 300 }

const MARKER_KEY = 'calls_daily_recap_last_posted'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase()
  const authorized = cronSecret ? authHeader === `Bearer ${cronSecret}` : userAgent.includes('vercel-cron')
  if (!authorized) return res.status(401).json({ error: 'Unauthorised' })

  const bris = new Date(Date.now() + 10 * 3600_000)
  const win = brisbaneDayWindow()
  const dow = bris.getUTCDay()
  const forced = req.query.send === '1'

  if (!forced) {
    if (dow === 0 || dow === 6) return res.status(200).json({ ok: true, skipped: 'weekend', ymd: win.ymd })
    if (bris.getUTCHours() < 18) return res.status(200).json({ ok: true, skipped: 'before 18:00 Brisbane', ymd: win.ymd })
    const { data } = await sb().from('app_settings').select('value').eq('key', MARKER_KEY).maybeSingle()
    if (data?.value && String(data.value) === win.ymd) {
      return res.status(200).json({ ok: true, skipped: 'already posted today', ymd: win.ymd })
    }
  }

  try {
    const r = await postDailyRecap(new Date())
    // Marked only once Slack has taken it, so a Slack outage retries next hour
    // rather than losing the day. A day with nothing analysed is also marked —
    // there is nothing to retry for, and re-checking hourly would be pointless.
    if (!forced && (r.posted || r.skipped === 'nothing analysed today')) {
      await sb().from('app_settings').upsert(
        { key: MARKER_KEY, value: win.ymd as any, updated_at: new Date().toISOString() },
        { onConflict: 'key' })
    }
    return res.status(200).json({ ok: true, ...r })
  } catch (e: any) {
    console.error('calls-daily-recap failed:', e?.message || e)
    return res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
}
