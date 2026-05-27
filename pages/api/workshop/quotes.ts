// pages/api/workshop/quotes.ts
// GET  ?status=  — list quotes (with customer + vehicle) for the quotes board
// POST           — create a draft quote (edit:bookings)

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

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const status = String(req.query.status || '').trim()
    let q = db.from('workshop_quotes')
      .select(`id, status, subtotal, gst, total, notes, created_at,
               customer:workshop_customers(id, name),
               vehicle:workshop_vehicles(id, rego, make, model, year)`)
      .order('created_at', { ascending: false })
      .limit(200)
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ quotes: data || [] })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const { data, error } = await db.from('workshop_quotes').insert({
      customer_id: body.customer_id || null,
      vehicle_id: body.vehicle_id || null,
      notes: body.notes ? String(body.notes) : null,
      created_by: user.id,
    }).select('id').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ ok: true, id: data.id })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
