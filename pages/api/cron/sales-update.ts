// pages/api/cron/sales-update.ts
// 5:15pm Brisbane: post the day's sales to #sales-updates. On Friday it posts
// the week instead (Chris, 2026-08-31). Weekends are skipped.
//
// Scheduled hourly rather than once a day, and guarded by a marker, for the
// reason the tune-job chase had to be rewritten the same day: a once-a-day
// cron that collides with a deploy is skipped silently and nobody finds out.
// Here the marker is the Brisbane date, so any pass from 17:15 onwards posts
// it once and later passes do nothing.
//
// Auth: Bearer CRON_SECRET, with the vercel-cron user-agent fallback.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { postSalesUpdate } from '../../../lib/sales-update-slack'

export const config = { maxDuration: 120 }

const MARKER_KEY = 'sales_update_last_posted'

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

  const bris = new Date(Date.now() + 10 * 3600_000)      // Brisbane = UTC+10, no DST
  const today = bris.toISOString().slice(0, 10)
  const dow = bris.getUTCDay()                            // 0 Sun .. 6 Sat
  const minutes = bris.getUTCHours() * 60 + bris.getUTCMinutes()
  const forced = req.query.send === '1'

  // Weekdays only — nobody is writing orders on a Sunday, and an empty post
  // every weekend trains people to ignore the channel.
  const isWeekday = dow >= 1 && dow <= 5
  const dueNow = minutes >= 17 * 60 + 15                  // 17:15 Brisbane onwards

  if (!forced) {
    if (!isWeekday) return res.status(200).json({ ok: true, skipped: 'weekend', today })
    if (!dueNow) return res.status(200).json({ ok: true, skipped: 'before 17:15 Brisbane', today })
    const { data } = await sb().from('app_settings').select('value').eq('key', MARKER_KEY).maybeSingle()
    if (data?.value && String(data.value) === today) {
      return res.status(200).json({ ok: true, skipped: 'already posted today', today })
    }
  }

  const mode = (req.query.mode === 'weekly' || req.query.mode === 'daily')
    ? req.query.mode as 'weekly' | 'daily'
    : (dow === 5 ? 'weekly' : 'daily')                    // Friday gets the week

  try {
    const r = await postSalesUpdate(mode, new Date())
    // Only mark the day done once Slack actually accepted it, so a Slack
    // outage retries on the next pass instead of losing the day.
    if (r.posted && !forced) {
      await sb().from('app_settings').upsert(
        { key: MARKER_KEY, value: today as any, updated_at: new Date().toISOString() },
        { onConflict: 'key' })
    }
    return res.status(200).json({ ok: true, today, ...r })
  } catch (e: any) {
    console.error('sales-update cron failed:', e?.message || e)
    return res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
}
