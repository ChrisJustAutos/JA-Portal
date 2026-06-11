// pages/api/workshop/customers.ts
// GET  ?q=     — search customers by name / phone / mobile / email (max 20).
// POST         — quick-create a customer (edit:bookings). MYOB sync fills
//                myob_uid later; portal-created rows start with it null.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { logWorkshopActivity } from '../../../lib/workshop-activity'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const q = String(req.query.q || '').trim().replace(/[%,()*]/g, ' ').trim()
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 20))
    const offset = Math.max(0, Number(req.query.offset) || 0)
    // Exact counts scan every matching row — only the paginated Customers
    // screen needs the total (it passes count=1). The entity pickers fire a
    // query per keystroke and skip it.
    const wantCount = String(req.query.count || '') === '1'
    let query = db.from('workshop_customers')
      .select('id, name, first_name, last_name, phone, mobile, email, company, customer_number', wantCount ? { count: 'exact' } : undefined)
      .order('name', { ascending: true })
      .range(offset, offset + limit - 1)
    if (q) query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%,mobile.ilike.%${q}%,email.ilike.%${q}%`)
    const { data, count, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ customers: data || [], total: count || 0 })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }

    const name = String(body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name required' })
    const { data, error } = await db.from('workshop_customers').insert({
      name,
      first_name: body.first_name ? String(body.first_name) : null,
      last_name: body.last_name ? String(body.last_name) : null,
      phone: body.phone ? String(body.phone) : null,
      mobile: body.mobile ? String(body.mobile) : null,
      email: body.email ? String(body.email) : null,
      address: body.address ? String(body.address) : null,
    }).select('id, name, phone, mobile').single()
    if (error) return res.status(500).json({ error: error.message })
    await logWorkshopActivity(db, { action: 'created', entity: 'customer', entity_id: data.id, entity_label: data.name, detail: `Customer "${data.name}" added`, actor_id: user.id, actor_name: user.displayName || user.email })
    return res.status(201).json({ ok: true, customer: data })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
