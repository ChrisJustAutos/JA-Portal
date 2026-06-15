// pages/api/b2b/admin/stock-boards/[id].ts
// PATCH  — update a view (name / columns / thresholds / item_ids / sort_order)
// DELETE — remove a view
// Permission: edit:b2b_catalogue
import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth, PortalUser } from '../../../../../lib/authServer'
import { roleHasPermission } from '../../../../../lib/permissions'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

const ALLOWED_COLUMNS = [2, 3, 4, 6, 8, 12]

export default withAuth('view:b2b', async (req: NextApiRequest, res: NextApiResponse, user: PortalUser) => {
  if (!roleHasPermission(user.role, 'edit:b2b_catalogue')) return res.status(403).json({ error: 'Forbidden' })
  const c = sb()
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'PATCH') {
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const patch: any = { updated_at: new Date().toISOString() }
    if ('name' in body) patch.name = String(body.name || '').trim()
    if ('columns' in body) patch.columns = ALLOWED_COLUMNS.includes(Number(body.columns)) ? Number(body.columns) : 4
    if ('red_below' in body) patch.red_below = Math.max(0, Math.round(Number(body.red_below) || 0))
    if ('amber_below' in body) patch.amber_below = body.amber_below == null || body.amber_below === '' ? null : Math.max(0, Math.round(Number(body.amber_below) || 0))
    if ('item_ids' in body) patch.item_ids = Array.isArray(body.item_ids) ? body.item_ids.filter((x: any) => typeof x === 'string') : []
    if ('sort_order' in body) patch.sort_order = Math.round(Number(body.sort_order) || 0)
    const { error } = await c.from('b2b_stock_boards').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const { error } = await c.from('b2b_stock_boards').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'PATCH, DELETE')
  return res.status(405).json({ error: 'PATCH or DELETE only' })
})
