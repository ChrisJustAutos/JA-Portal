// pages/api/reports/sales-figures.ts
//
// Daily / monthly / period sales figures for Reports → Sales Dashboard.
// The money-over-time half of the Monday "Sales Dashboard" (2079976); the
// quote pipeline half is /api/reports/sales-dashboard.
//
// "Sales" = ORDERS/BOOKINGS TAKEN, not invoiced turnover — same meaning as the
// Sales Report. Turnover is the Forecast report.
//
// Auth: view:reports, same as the Sales Report.
// Query: ?months=1..24 (default 12) · ?days=7..180 daily window (default 60)

import type { NextApiRequest, NextApiResponse } from 'next'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { fetchSalesFigures } from '../../../lib/sales-figures-monday'

export const config = { maxDuration: 60 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getCurrentUser(req)
  if (!user || !roleHasPermission(user.role, 'view:reports')) {
    return res.status(401).json({ error: 'Unauthorised' })
  }

  const token = process.env.MONDAY_API_TOKEN
  if (!token) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })

  const months = Number(req.query.months) || 12
  const dailyWindowDays = Number(req.query.days) || 60

  try {
    const data = await fetchSalesFigures(token, { months, dailyWindowDays })
    return res.status(200).json(data)
  } catch (e: any) {
    console.error('[reports/sales-figures] failed:', e?.message || e)
    return res.status(500).json({ error: 'Sales figures pull failed', message: e?.message || String(e) })
  }
}
