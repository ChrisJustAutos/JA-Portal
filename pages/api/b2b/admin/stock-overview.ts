// pages/api/b2b/admin/stock-overview.ts
// GET  — the shared stock-overview board: its config, the pinned tiles (with
//        current cached on-hand qty) and a lightweight catalogue list for the
//        item picker. (view:b2b)
// PUT  — save the board config: columns, colour thresholds, ordered item_ids.
//        (edit:b2b_catalogue)
import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const ALLOWED_COLUMNS = [2, 3, 4, 6, 8, 12]

async function readConfig(c: SupabaseClient) {
  const { data } = await c.from('b2b_stock_overview_config').select('*').eq('id', 'singleton').maybeSingle()
  return data || { id: 'singleton', columns: 4, red_below: 5, amber_below: null, item_ids: [] }
}

export default withAuth('view:b2b', async (req: NextApiRequest, res: NextApiResponse, user) => {
  const c = sb()

  if (req.method === 'GET') {
    const config = await readConfig(c)
    // Lightweight list for the picker — every catalogue row.
    const { data: all, error } = await c.from('b2b_catalogue')
      .select('id, sku, name, qty_on_hand, is_inventoried, stock_cached_at, primary_image_url')
      .order('sku', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    const byId = new Map((all || []).map((r: any) => [r.id, r]))
    // Pinned tiles, in the configured order, skipping any deleted catalogue rows.
    const tiles = (config.item_ids || []).map((id: string) => byId.get(id)).filter(Boolean)
    return res.status(200).json({ config, tiles, all: all || [] })
  }

  if (req.method === 'PUT') {
    if (!roleHasPermission(user.role, 'edit:b2b_catalogue')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }

    const patch: any = { updated_at: new Date().toISOString(), updated_by: user.id }
    if ('columns' in body) patch.columns = ALLOWED_COLUMNS.includes(Number(body.columns)) ? Number(body.columns) : 4
    if ('red_below' in body) patch.red_below = Math.max(0, Math.round(Number(body.red_below) || 0))
    if ('amber_below' in body) patch.amber_below = body.amber_below == null || body.amber_below === '' ? null : Math.max(0, Math.round(Number(body.amber_below) || 0))
    if ('item_ids' in body) patch.item_ids = Array.isArray(body.item_ids) ? body.item_ids.filter((x: any) => typeof x === 'string') : []

    const { error } = await c.from('b2b_stock_overview_config').update(patch).eq('id', 'singleton')
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, config: await readConfig(c) })
  }

  res.setHeader('Allow', 'GET, PUT')
  return res.status(405).json({ error: 'GET or PUT only' })
})
