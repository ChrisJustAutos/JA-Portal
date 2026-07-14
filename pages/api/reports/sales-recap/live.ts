// pages/api/reports/sales-recap/live.ts
//
// LIVE Weekly Sales Recap for the Reports → Sales Report page. Pulls the
// Monday order/booking data fresh on every call (so sections 1-3 + flags are
// always current) and splices in the most recent MechanicDesk scrape (diary
// notes + forward forecast) stored by the last full run — those sections are
// "as of" that scrape. No storing, no email; this is a read-only live view.
//
// Auth: staff with view:reports. Query: ?week=current|previous (default previous).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { getCurrentUser } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { fetchOrders, fetchDistBookings } from '../../../../lib/sales-recap-monday'
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
  const week = wantCurrent ? currentTradingWeek(nowMs) : previousTradingWeek(nowMs)

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
    const yearStart = `${new Date(nowMs).getUTCFullYear()}-01-01`
    const today = new Date(nowMs).toISOString().slice(0, 10)
    const [orders, dist] = await Promise.all([
      fetchOrders(token, yearStart, today),
      fetchDistBookings(token, yearStart, today),
    ])

    let recap = assembleRecap({ nowMs, orders, dist, diaryNotes, forecast, week })
    const llm = await generateFlags(recap).catch(() => [])
    if (llm.length) recap = { ...recap, flags: llm }

    const html = renderRecapHtml(recap)

    return res.status(200).json({
      ok: true,
      weekMode: wantCurrent ? 'current' : 'previous',
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
