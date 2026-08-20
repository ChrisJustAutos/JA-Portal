// pages/api/reports/sales-dashboard.ts
//
// Reports → Sales Dashboard. Quote pipeline across the five rep Quote Channel
// boards — the portal rebuild of the Monday "Sales Dashboard" (2079976).
//
// Auth: view:reports, same as the Sales Report. This is pipeline and rep
// activity, not whole-of-group turnover, so it is not restricted to
// admin+manager the way the Management Dashboard and Forecast are.
//
// Query: ?months=3|6|12|24 (default 12) — the window for Won/Lost. The open
// pipeline is always current regardless of the window.
//
// Cost: the five boards hold ~6,500 items between them, so this pulls the open
// groups in full plus Won/Lost filtered to the window server-side by Monday.
// A 60s budget covers it comfortably; nothing is stored.

import type { NextApiRequest, NextApiResponse } from 'next'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { fetchSalesDashboard } from '../../../lib/sales-dashboard-monday'

export const config = { maxDuration: 60 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getCurrentUser(req)
  if (!user || !roleHasPermission(user.role, 'view:reports')) {
    return res.status(401).json({ error: 'Unauthorised' })
  }

  const token = process.env.MONDAY_API_TOKEN
  if (!token) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })

  const months = Number(req.query.months) || 12

  try {
    const data = await fetchSalesDashboard(token, { months })
    return res.status(200).json(data)
  } catch (e: any) {
    console.error('[reports/sales-dashboard] failed:', e?.message || e)
    return res.status(500).json({ error: 'Sales dashboard pull failed', message: e?.message || String(e) })
  }
}
