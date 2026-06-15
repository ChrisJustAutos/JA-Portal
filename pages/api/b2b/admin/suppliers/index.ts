// pages/api/b2b/admin/suppliers/index.ts
// GET  — list supplier accounts with active-user + product counts (view:b2b)
// POST — create a supplier account (edit:b2b_distributors)
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

export default withAuth('view:b2b', async (req: NextApiRequest, res: NextApiResponse, user: PortalUser) => {
  const c = sb()

  if (req.method === 'GET') {
    const { data: suppliers, error } = await c.from('b2b_suppliers').select('*').order('name', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    const [{ data: users }, { data: cat }] = await Promise.all([
      c.from('b2b_supplier_users').select('supplier_id, is_active'),
      c.from('b2b_catalogue').select('myob_supplier_uid'),
    ])
    const catCount = new Map<string, number>()
    for (const r of (cat || []) as any[]) if (r.myob_supplier_uid) catCount.set(r.myob_supplier_uid, (catCount.get(r.myob_supplier_uid) || 0) + 1)
    const userCount = new Map<string, number>()
    for (const u of (users || []) as any[]) if (u.is_active) userCount.set(u.supplier_id, (userCount.get(u.supplier_id) || 0) + 1)
    const items = (suppliers || []).map((s: any) => ({
      ...s,
      active_user_count: userCount.get(s.id) || 0,
      product_count: (s.myob_supplier_uids || []).reduce((n: number, uid: string) => n + (catCount.get(uid) || 0), 0),
    }))
    return res.status(200).json({ items })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:b2b_distributors')) return res.status(403).json({ error: 'Forbidden' })
    const body = (req.body && typeof req.body === 'object') ? req.body : {}
    const name = String(body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name required' })
    const uids = Array.isArray(body.myob_supplier_uids) ? body.myob_supplier_uids.filter((x: any) => typeof x === 'string' && x) : []
    const { data, error } = await c.from('b2b_suppliers').insert({
      name, myob_supplier_uids: uids, notes: body.notes ? String(body.notes) : null, created_by: user.id,
    }).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ item: data })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
