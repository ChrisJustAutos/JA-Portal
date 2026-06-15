// pages/api/b2b/admin/suppliers/[id].ts
// GET    — one supplier + its users (view:b2b)
// PATCH  — edit name / myob_supplier_uids / notes / is_active (edit:b2b_distributors)
// DELETE — deactivate the supplier (edit:b2b_distributors); reversible via PATCH
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
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'GET') {
    const { data: supplier, error } = await c.from('b2b_suppliers').select('*').eq('id', id).maybeSingle()
    if (error || !supplier) return res.status(404).json({ error: 'Not found' })
    const { data: users } = await c.from('b2b_supplier_users')
      .select('id, email, full_name, is_active, invited_at, last_login_at').eq('supplier_id', id).order('created_at', { ascending: true })
    return res.status(200).json({ supplier, users: users || [] })
  }

  if (!roleHasPermission(user.role, 'edit:b2b_distributors')) return res.status(403).json({ error: 'Forbidden' })

  if (req.method === 'PATCH') {
    const body = (req.body && typeof req.body === 'object') ? req.body : {}
    const patch: any = { updated_at: new Date().toISOString() }
    if ('name' in body) patch.name = String(body.name || '').trim()
    if ('notes' in body) patch.notes = body.notes ? String(body.notes) : null
    if ('is_active' in body) patch.is_active = !!body.is_active
    if ('myob_supplier_uids' in body) patch.myob_supplier_uids = Array.isArray(body.myob_supplier_uids) ? body.myob_supplier_uids.filter((x: any) => typeof x === 'string' && x) : []
    const { error } = await c.from('b2b_suppliers').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const { error } = await c.from('b2b_suppliers').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, PATCH or DELETE only' })
})
