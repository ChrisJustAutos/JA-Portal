// pages/api/dashboard/layout.ts
// GET    — return my layout for a dashboard (falls back to default if unset)
// POST   — save my layout (full replace of widgets + global date config)
// DELETE — reset my layout back to the shared default

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth, getSessionUser } from '../../../lib/auth'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const user = await getSessionUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }
    const dashboardKey = String(req.query.key || 'overview')

    if (req.method === 'GET') {
      const { data: userLayout } = await sb()
        .from('dashboard_layouts')
        .select('*')
        .eq('user_id', user.id)
        .eq('dashboard_key', dashboardKey)
        .maybeSingle()

      if (userLayout) {
        res.status(200).json({
          widgets: userLayout.widgets || [],
          global_date_range: userLayout.global_date_range,
          global_date_from: userLayout.global_date_from,
          global_date_to: userLayout.global_date_to,
          is_default: false,
        })
        return
      }

      // No user layout — return default
      const { data: def } = await sb()
        .from('dashboard_defaults')
        .select('widgets')
        .eq('dashboard_key', dashboardKey)
        .maybeSingle()
      res.status(200).json({
        widgets: def?.widgets || [],
        global_date_range: 'today',
        global_date_from: null,
        global_date_to: null,
        is_default: true,
      })
      return
    }

    if (req.method === 'POST') {
      const body = req.body || {}
      const widgets = Array.isArray(body.widgets) ? body.widgets : []
      const global_date_range = body.global_date_range || 'today'
      const global_date_from = body.global_date_from || null
      const global_date_to = body.global_date_to || null

      // Upsert
      const { error } = await sb().from('dashboard_layouts').upsert({
        user_id: user.id,
        dashboard_key: dashboardKey,
        widgets,
        global_date_range,
        global_date_from,
        global_date_to,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,dashboard_key' })
      if (error) { res.status(500).json({ error: error.message }); return }
      res.status(200).json({ ok: true })
      return
    }

    if (req.method === 'DELETE') {
      const { error } = await sb().from('dashboard_layouts')
        .delete()
        .eq('user_id', user.id)
        .eq('dashboard_key', dashboardKey)
      if (error) { res.status(500).json({ error: error.message }); return }
      res.status(200).json({ ok: true, message: 'Layout reset to default' })
      return
    }

    res.status(405).end()
  })
}
