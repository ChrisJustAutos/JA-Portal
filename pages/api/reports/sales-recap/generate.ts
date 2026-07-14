// pages/api/reports/sales-recap/generate.ts
//
// Weekly Sales Recap generator. The GH-Actions runner (Mon 7am) scrapes the
// MechanicDesk diary notes + forward forecast (the only Playwright-needing
// bit) and POSTs them here; this endpoint pulls the Monday orders/distributor
// data itself, assembles the six sections, writes the LLM flags, renders the
// HTML, stores the report, and emails the recipients.
//
// Auth: X-Service-Token (scope 'stocktake:write') OR Bearer CRON_SECRET.
// Body: { diaryNotes: [...], forecast: [...], dryRun?: bool, nowMs?: number }

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { validateServiceToken } from '../../../../lib/service-auth'
import { fetchOrders, fetchDistBookings, fetchQuoteLeads } from '../../../../lib/sales-recap-monday'
import { assembleRecap, previousTradingWeek } from '../../../../lib/sales-recap'
import { renderRecapHtml } from '../../../../lib/sales-recap-html'
import { generateFlags } from '../../../../lib/sales-recap-flags'
import { sendMail } from '../../../../lib/email'
import { getFromMailbox } from '../../../../lib/b2b-settings'

export const config = { maxDuration: 120 }

// Weekly delivery goes to Ryan only (Chris 2026-07-15; was Ryan/Matt/Chris).
const RECIPIENTS = (process.env.SALES_RECAP_RECIPIENTS ||
  'ryan@justautosmechanical.com.au')
  .split(',').map(s => s.trim()).filter(Boolean)

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronOk = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`
  if (!cronOk && !(await validateServiceToken(req, 'stocktake:write'))) {
    return res.status(401).json({ error: 'Unauthorised' })
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const token = process.env.MONDAY_API_TOKEN
  if (!token) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
  const diaryNotes = Array.isArray(body.diaryNotes) ? body.diaryNotes : []
  const forecast = Array.isArray(body.forecast) ? body.forecast : []
  const dryRun = body.dryRun === true
  const sendEmail = body.email !== false // default: email the team; a portal "refresh workshop data" run passes email:false
  const nowMs = typeof body.nowMs === 'number' ? body.nowMs : Date.now()

  try {
    // Pull year-to-date Monday data (covers daily, rolling 4-week, monthly).
    const yearStart = `${new Date(nowMs).getUTCFullYear()}-01-01`
    const today = new Date(nowMs).toISOString().slice(0, 10)
    const [orders, dist, quoteLeads] = await Promise.all([
      fetchOrders(token, yearStart, today),
      fetchDistBookings(token, yearStart, today),
      // Overnight quote-channel leads — Mon 7am run reaches back to Fri 5:30pm.
      fetchQuoteLeads(token, nowMs - 4 * 86400_000).catch(() => null),
    ])

    // Assemble (rule-based flags first), then upgrade to LLM flags if available.
    let recap = assembleRecap({ nowMs, orders, dist, diaryNotes, forecast, quoteLeads })
    const llm = await generateFlags(recap).catch(() => [])
    if (llm.length) recap = { ...recap, flags: llm }

    const html = renderRecapHtml(recap)

    if (dryRun) return res.status(200).json({ ok: true, dryRun: true, week: recap.week, recap, htmlPreview: html.slice(0, 400) })

    const c = sb()
    await c.from('sales_recap_reports').update({ is_current: false }).eq('is_current', true)
    const { error: upErr } = await c.from('sales_recap_reports').upsert({
      week_start: recap.week.start, week_end: recap.week.end,
      generated_at: new Date(nowMs).toISOString(), payload: recap, html,
      md_inputs: { diaryNotes, forecast }, // raw scrape → lets the live view re-assemble against fresh Monday data
      emailed_to: sendEmail ? RECIPIENTS.join(', ') : null, is_current: true,
    }, { onConflict: 'week_start' })
    if (upErr) throw new Error(`store: ${upErr.message}`)

    let emailed = false
    if (sendEmail) {
      try {
        await sendMail(await getFromMailbox(), {
          to: RECIPIENTS,
          subject: `Weekly Sales Recap — week of ${recap.week.start}`,
          html,
        })
        emailed = true
      } catch (e: any) {
        console.error('[sales-recap] email failed:', e?.message || e)
      }
    }

    return res.status(200).json({ ok: true, week: recap.week, emailed, recipients: sendEmail ? RECIPIENTS : [], flags: recap.flags.length })
  } catch (e: any) {
    console.error('[sales-recap] generate failed:', e?.message || e)
    return res.status(500).json({ error: (e?.message || String(e)).slice(0, 400) })
  }
}
