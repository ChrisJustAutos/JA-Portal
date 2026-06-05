// pages/api/workshop/suppliers.ts
// GET  — list suppliers (view:diary)
// POST — create a supplier (edit:bookings)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

const FIELDS = ['name', 'contact_name', 'phone', 'email', 'address', 'myob_supplier_uid', 'myob_supplier_name', 'notes', 'is_active']

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()
  if (req.method === 'GET') {
    const { data, error } = await db.from('workshop_suppliers').select('*').is('deleted_at', null).order('name', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ suppliers: data || [] })
  }
  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const name = String(body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name required' })
    const row: any = { created_by: user.id }
    for (const f of FIELDS) if (f in body) row[f] = f === 'is_active' ? !!body[f] : (body[f] || null)
    row.name = name
    const { data, error } = await db.from('workshop_suppliers').insert(row).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ ok: true, supplier: data })
  }
  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
