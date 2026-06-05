// pages/api/workshop/vehicle-models.ts
// GET  — list vehicle models (view:diary)
// POST — create a model (edit:bookings)

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
    const { data, error } = await db.from('workshop_vehicle_models').select('id, name, sort_order').is('deleted_at', null).order('sort_order', { ascending: true }).order('name', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ models: data || [] })
  }
  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const name = String(body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name required' })
    const { data, error } = await db.from('workshop_vehicle_models').insert({ name, sort_order: Number(body.sort_order) || 0, created_by: user.id }).select('id, name, sort_order').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ ok: true, model: data })
  }
  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
