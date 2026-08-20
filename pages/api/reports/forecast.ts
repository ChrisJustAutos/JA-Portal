// pages/api/reports/forecast.ts
//
// Reports → Forecast. Serves the Monday "Forecasting" board (1842188200) as
// month × entity × year turnover — the portal rebuild of the Monday
// "Forecast Dashboard - Includes JAWS".
//
// Read-only and live: the board is 24 items, so a fresh pull costs one Monday
// query and there is nothing to cache or store.
//
// Auth: management figures, so admin + manager only — matching the Management
// Dashboard rather than the wider view:reports used by the other reports.

import type { NextApiRequest, NextApiResponse } from 'next'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { fetchForecast } from '../../../lib/forecast-monday'

export const config = { maxDuration: 30 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getCurrentUser(req)
  if (!user || !roleHasPermission(user.role, 'view:reports')) {
    return res.status(401).json({ error: 'Unauthorised' })
  }
  if (!['admin', 'manager'].includes(user.role)) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const token = process.env.MONDAY_API_TOKEN
  if (!token) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })

  try {
    const data = await fetchForecast(token)
    return res.status(200).json(data)
  } catch (e: any) {
    console.error('[reports/forecast] failed:', e?.message || e)
    return res.status(500).json({ error: 'Forecast pull failed', message: e?.message || String(e) })
  }
}
