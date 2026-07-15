// pages/api/cron/overnight-leads-snapshot.ts
//
// Half-hourly snapshot of the Monday quote-channel "Quote - Lead" groups into
// sales_recap_overnight_leads (migration 164). Leads move OUT of the group as
// staff quote them, so this running around the clock is what makes the Sales
// Report's Overnight Leads panel correct for past dates — a lead captured at
// 2am stays counted even after it's moved to Pending at 7:30am.
//
// Auth: Authorization: Bearer $CRON_SECRET (Vercel cron).

import type { NextApiRequest, NextApiResponse } from 'next'
import { snapshotQuoteLeads } from '../../../lib/sales-recap-leads-store'

export const config = { maxDuration: 60 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ok = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`
  if (!ok) return res.status(401).json({ error: 'Unauthorized' })

  const token = process.env.MONDAY_API_TOKEN
  if (!token) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })

  try {
    const r = await snapshotQuoteLeads(token)
    return res.status(200).json({ ok: true, seen: r.seen })
  } catch (e: any) {
    console.error('[overnight-leads-snapshot] failed:', e?.message || e)
    return res.status(500).json({ ok: false, error: (e?.message || String(e)).slice(0, 300) })
  }
}
