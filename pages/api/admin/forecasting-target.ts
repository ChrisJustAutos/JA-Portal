// pages/api/admin/forecasting-target.ts
// GET / PUT the global monthly forecasting target.
//
// Used to draw a horizontal reference line on the Forecasting page's monthly
// bar chart. Single org-wide value (one number, applied across all months).
//
//   GET: any authenticated user
//   PUT: admin only

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth, requireAdmin, getSessionUser } from '../../../lib/auth'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return requireAuth(req, res, async () => {
      const { data, error } = await sb()
        .from('app_settings')
        .select('value, updated_at')
        .eq('key', 'forecasting_monthly_target')
        .maybeSingle()
      if (error) { res.status(500).json({ error: error.message }); return }
      res.status(200).json({ target_monthly: Number(data?.value || 0), updated_at: data?.updated_at || null })
    })
  }

  if (req.method === 'PUT') {
    return requireAdmin(req, res, async () => {
      const user = await getSessionUser(req)
      const { target_monthly } = req.body || {}
      const num = Number(target_monthly)
      if (!isFinite(num) || num < 0) {
        res.status(400).json({ error: 'target_monthly must be a non-negative number' })
        return
      }
      const rounded = Math.round(num)

      const { error } = await sb()
        .from('app_settings')
        .upsert({
          key: 'forecasting_monthly_target',
          value: rounded as any,
          updated_at: new Date().toISOString(),
          updated_by: user?.id || null,
        }, { onConflict: 'key' })
      if (error) { res.status(500).json({ error: error.message }); return }
      res.status(200).json({ ok: true, target_monthly: rounded })
    })
  }

  res.setHeader('Allow', 'GET, PUT')
  res.status(405).end()
}
