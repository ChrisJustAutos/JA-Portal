// pages/api/reports/sales-recap/live.ts
//
// LIVE Weekly Sales Recap for the Reports → Sales Report page. Pulls the
// Monday order/booking data fresh on every call (so sections 1-3 + flags are
// always current) and splices in the most recent MechanicDesk scrape (diary
// notes + forward forecast) stored by the last full run — those sections are
// "as of" that scrape. No storing, no email; this is a read-only live view.
//
// Auth: staff with view:reports.
// Query: ?week=current|previous (default previous), OR ?start=YYYY-MM-DD&end=YYYY-MM-DD
// for an arbitrary date range (capped at ~3 months so the daily table stays sane).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { getCurrentUser } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { fetchOrders, fetchDistBookings, fetchQuoteLeads } from '../../../../lib/sales-recap-monday'
import { assembleRecap, previousTradingWeek, currentTradingWeek } from '../../../../lib/sales-recap'
import { renderRecapHtml } from '../../../../lib/sales-recap-html'
import { generateFlags } from '../../../../lib/sales-recap-flags'

export const config = { maxDuration: 60 }

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getCurrentUser(req)
  if (!user || !roleHasPermission(user.role, 'view:reports')) return res.status(401).json({ error: 'Unauthorised' })

  const token = process.env.MONDAY_API_TOKEN
  if (!token) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })

  const wantCurrent = req.query.week === 'current'
  const nowMs = Date.now()

  // Custom range takes precedence over the week toggle when both dates parse.
  const YMD = /^\d{4}-\d{2}-\d{2}$/
  const startQ = typeof req.query.start === 'string' && YMD.test(req.query.start) ? req.query.start : null
  const endQ = typeof req.query.end === 'string' && YMD.test(req.query.end) ? req.query.end : null
  let week = wantCurrent ? currentTradingWeek(nowMs) : previousTradingWeek(nowMs)
  let weekMode: string = wantCurrent ? 'current' : 'previous'
  if (startQ && endQ) {
    if (startQ > endQ) return res.status(400).json({ error: 'start must be on or before end' })
    const spanDays = (Date.parse(endQ) - Date.parse(startQ)) / 86400_000
    if (spanDays > 92) return res.status(400).json({ error: 'Date range too long — max ~3 months' })
    week = { start: startQ, end: endQ }
    weekMode = 'custom'
  }

  try {
    // Latest stored report — source of the workshop (MD) sections + its scrape time.
    const { data: stored } = await sb()
      .from('sales_recap_reports')
      .select('generated_at, md_inputs')
      .eq('is_current', true)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const diaryNotes = Array.isArray(stored?.md_inputs?.diaryNotes) ? stored!.md_inputs.diaryNotes : []
    const forecast = Array.isArray(stored?.md_inputs?.forecast) ? stored!.md_inputs.forecast : []

    // Fresh Monday pull (year-to-date covers daily, rolling 4-week and monthly).
    // A custom range can reach back before Jan 1 — widen the pull so the daily
    // table and the 3 weeks of rolling comparison before it still have data.
    const yearStart = `${new Date(nowMs).getUTCFullYear()}-01-01`
    const rollingStart = new Date(Date.parse(week.start) - 28 * 86400_000).toISOString().slice(0, 10)
    const fetchStart = rollingStart < yearStart ? rollingStart : yearStart
    const today = new Date(nowMs).toISOString().slice(0, 10)
    const fetchEnd = week.end > today ? week.end : today
    const [orders, dist, quoteLeads] = await Promise.all([
      fetchOrders(token, fetchStart, fetchEnd),
      fetchDistBookings(token, fetchStart, fetchEnd),
      // 4 days back covers Monday morning's Fri-5:30pm window with margin.
      fetchQuoteLeads(token, nowMs - 4 * 86400_000).catch(() => null),
    ])

    let recap = assembleRecap({ nowMs, orders, dist, diaryNotes, forecast, week, quoteLeads })
    const llm = await generateFlags(recap).catch(() => [])
    if (llm.length) recap = { ...recap, flags: llm }

    const html = renderRecapHtml(recap)

    return res.status(200).json({
      ok: true,
      weekMode,
      recap,
      html,
      ordersAsOf: new Date(nowMs).toISOString(),
      workshopAsOf: stored?.generated_at || null, // null = MD sections never scraped yet
    })
  } catch (e: any) {
    console.error('[sales-recap/live] failed:', e?.message || e)
    return res.status(500).json({ error: (e?.message || String(e)).slice(0, 400) })
  }
}
