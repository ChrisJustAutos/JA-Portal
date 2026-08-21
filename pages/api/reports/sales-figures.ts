// pages/api/reports/sales-figures.ts
//
// Daily / monthly / per-salesperson sales figures for Reports → Sales
// Dashboard, over any date range. The money-over-time half of the Monday
// "Sales Dashboard" (2079976); the quote pipeline half is
// /api/reports/sales-dashboard.
//
// "Sales" = ORDERS/BOOKINGS TAKEN, not invoiced turnover — same meaning as the
// Sales Report. Turnover is the Forecast report.
//
// Auth: view:reports, same as the Sales Report.
// Query:
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD   explicit range (wins over months)
//   ?months=1..36                      shortcut, back from today (default 12)
//   ?days=1..180                       daily-chart window (default 60)
//   ?person=<name>                     scope everything but the people table
//   ?exceptions=1                      also return the Cancelled / Postponed
//                                      order totals (an extra Monday pull, so
//                                      it is opt-in — only the Management view
//                                      needs them)
//
// `targets` is always returned: the per-month / per-person / per-day sales
// targets behind the Management view's target lines, resolved DB-first through
// lib/integration-config (SALES_TARGET_PER_MONTH / _PER_PERSON / _PER_DAY).

import type { NextApiRequest, NextApiResponse } from 'next'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { fetchSalesFigures, getSalesTargets, fetchOrderExceptions } from '../../../lib/sales-figures-monday'

export const config = { maxDuration: 60 }

const YMD = /^\d{4}-\d{2}-\d{2}$/
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getCurrentUser(req)
  if (!user || !roleHasPermission(user.role, 'view:reports')) {
    return res.status(401).json({ error: 'Unauthorised' })
  }

  const token = process.env.MONDAY_API_TOKEN
  if (!token) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })

  const startQ = str(req.query.start)
  const endQ = str(req.query.end)
  const since = startQ && YMD.test(startQ) ? startQ : undefined
  const until = endQ && YMD.test(endQ) ? endQ : undefined

  const wantExceptions = req.query.exceptions === '1'

  try {
    const [data, targets, exceptions] = await Promise.all([
      fetchSalesFigures(token, {
        since, until,
        months: Number(req.query.months) || 12,
        dailyWindowDays: Number(req.query.days) || 60,
        person: str(req.query.person) ?? null,
      }),
      getSalesTargets(),
      wantExceptions
        ? fetchOrderExceptions(token, process.env.SALES_EXCEPTIONS_INCLUDE_PREV_YEARS === '1')
        : Promise.resolve(null),
    ])
    return res.status(200).json({ ...data, targets, exceptions })
  } catch (e: any) {
    console.error('[reports/sales-figures] failed:', e?.message || e)
    return res.status(500).json({ error: 'Sales figures pull failed', message: e?.message || String(e) })
  }
}
