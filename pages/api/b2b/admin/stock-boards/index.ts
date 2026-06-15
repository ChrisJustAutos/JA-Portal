// pages/api/b2b/admin/stock-boards/index.ts
// GET  — all saved Stock Wall views + a lightweight catalogue list for the
//        picker. (view:b2b)
// POST — create a new view. (edit:b2b_catalogue)
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
  const c = sb()

  if (req.method === 'GET') {
    const [{ data: boards, error }, { data: all, error: aErr }] = await Promise.all([
      c.from('b2b_stock_boards').select('*').order('sort_order', { ascending: true }).order('created_at', { ascending: true }),
      c.from('b2b_catalogue').select('id, sku, name, qty_on_hand, is_inventoried, stock_cached_at, primary_image_url, stock_red_below, stock_amber_below').order('sku', { ascending: true }),
    ])
    if (error) return res.status(500).json({ error: error.message })
    if (aErr) return res.status(500).json({ error: aErr.message })
    return res.status(200).json({ boards: boards || [], all: all || [] })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:b2b_catalogue')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const name = String(body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name required' })
    const { data: last } = await c.from('b2b_stock_boards').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle()
    const insert: any = {
      name,
      columns: ALLOWED_COLUMNS.includes(Number(body.columns)) ? Number(body.columns) : 4,
      red_below: body.red_below == null ? 5 : Math.max(0, Math.round(Number(body.red_below) || 0)),
      amber_below: body.amber_below == null || body.amber_below === '' ? null : Math.max(0, Math.round(Number(body.amber_below) || 0)),
      item_ids: Array.isArray(body.item_ids) ? body.item_ids.filter((x: any) => typeof x === 'string') : [],
      sort_order: (Number(last?.sort_order) || 0) + 1,
      created_by: user.id,
    }
    const { data, error } = await c.from('b2b_stock_boards').insert(insert).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ board: data })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
