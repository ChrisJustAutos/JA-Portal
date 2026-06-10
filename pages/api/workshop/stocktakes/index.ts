// pages/api/workshop/stocktakes/index.ts
// Portal-native stocktake sessions (workshop_inventory).
//   GET  — list sessions (newest first)
//   POST {name, scope?} — start a session (snapshots matching stock items)
// Perms mirror the MD stocktake tab: view:stocktakes / edit:stocktakes.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { createStocktakeSession, WorkshopStocktakeError } from '../../../../lib/workshop-stocktake'

export const config = { maxDuration: 60 }

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default withAuth('view:stocktakes', async (req, res, user) => {
  if (req.method === 'GET') {
    const { data, error } = await sb().from('workshop_stocktakes')
      .select('id, st_seq, name, status, scope_filter, item_count, counted_count, variance_qty, variance_value, myob_adjustment_uid, applied_at, created_at')
      .is('deleted_at', null).order('created_at', { ascending: false }).limit(100)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ stocktakes: data || [] })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:stocktakes')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    try {
      const result = await createStocktakeSession(String(body.name || '').slice(0, 120), body.scope || null, user.id)
      return res.status(201).json({ ok: true, ...result })
    } catch (e: any) {
      if (e instanceof WorkshopStocktakeError) return res.status(409).json({ error: e.message, code: e.code })
      return res.status(500).json({ error: e?.message || 'Failed to start stocktake' })
    }
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
