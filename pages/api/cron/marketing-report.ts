// pages/api/cron/marketing-report.ts
//
// Monday morning: email the Weekly Marketing Report.
//
// Scheduled HOURLY across Monday morning and guarded by a marker, not as a
// single 7am slot — the same reason sales-update and the tune-job chase were
// rewritten: a once-a-day cron that collides with a deploy is skipped silently
// and nobody finds out until someone asks where their email went. Today alone
// had a dozen deploys. Any pass from 07:00 Brisbane on Monday sends it once;
// later passes see the marker and do nothing.
//
// The marker is the Monday's date and is only written once the send SUCCEEDS,
// so an email outage retries on the next pass rather than losing the week.
//
// Recipients live in app_settings (key `marketing_report_recipients`, comma
// separated) with an env fallback, because Vercel env edits are painful here
// and this list will change more often than the code does.
//
//   ?send=1   force a send now, ignoring day, hour and marker (testing)
//   ?dry=1    build and report what WOULD go, send nothing
//
// Auth: Bearer CRON_SECRET, with the vercel-cron user-agent fallback.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { buildMarketingReport } from '../../../lib/marketing-report'
import { renderMarketingHtml } from '../../../lib/marketing-report-html'
import { sendMail } from '../../../lib/email'
import { getFromMailbox } from '../../../lib/b2b-settings'

export const config = { maxDuration: 300 }

const MARKER_KEY = 'marketing_report_last_sent'
const RECIPIENTS_KEY = 'marketing_report_recipients'
// Murph (marketing manager). Spelt "micheal" deliberately — that is the address
// as it exists, and a helpfully corrected "michael@" would bounce.
const DEFAULT_RECIPIENTS = 'micheal@justautosmechanical.com.au'

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

  const bris = new Date(Date.now() + 10 * 3600_000)       // Brisbane = UTC+10, no DST
  const today = bris.toISOString().slice(0, 10)
  const dow = bris.getUTCDay()                             // 0 Sun .. 6 Sat
  const hour = bris.getUTCHours()
  const forced = req.query.send === '1'
  const dry = req.query.dry === '1'

  if (!forced) {
    if (dow !== 1) return res.status(200).json({ ok: true, skipped: 'not Monday', today })
    if (hour < 7) return res.status(200).json({ ok: true, skipped: 'before 07:00 Brisbane', today })
    const { data } = await sb().from('app_settings').select('value').eq('key', MARKER_KEY).maybeSingle()
    if (data?.value && String(data.value) === today) {
      return res.status(200).json({ ok: true, skipped: 'already sent this week', today })
    }
  }

  try {
    const report = await buildMarketingReport(sb())
    const html = renderMarketingHtml(report)

    const { data: rcpRow } = await sb().from('app_settings').select('value').eq('key', RECIPIENTS_KEY).maybeSingle()
    const recipients = String(rcpRow?.value || process.env.MARKETING_REPORT_RECIPIENTS || DEFAULT_RECIPIENTS)
      .split(',').map(s => s.trim()).filter(Boolean)

    if (dry || !recipients.length) {
      return res.status(200).json({
        ok: true, dryRun: true, today, recipients,
        week: report.week, weekTotal: report.weekTotal,
        uncovered: report.coverage?.outside ?? null,
        bytes: html.length,
      })
    }

    const from = await getFromMailbox()
    const subject = `Marketing report — week of ${report.week.start}`
    await sendMail(from, { to: recipients, subject, html })

    // Marked done only AFTER the send is accepted, so a mail outage retries on
    // the next hourly pass instead of quietly losing the week.
    if (!forced) {
      await sb().from('app_settings').upsert(
        { key: MARKER_KEY, value: today as any, updated_at: new Date().toISOString() },
        { onConflict: 'key' })
    }
    return res.status(200).json({ ok: true, today, sent: recipients, week: report.week })
  } catch (e: any) {
    console.error('marketing-report cron failed:', e?.message || e)
    return res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
}
