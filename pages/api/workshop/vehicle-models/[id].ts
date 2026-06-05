// pages/api/workshop/vehicle-models/[id].ts — rename / delete a model (edit:bookings).
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })
  if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })

  if (req.method === 'PATCH') {
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const patch: any = {}
    if ('name' in body) patch.name = String(body.name).trim()
    if ('sort_order' in body) patch.sort_order = Number(body.sort_order) || 0
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No fields' })
    const { error } = await db.from('workshop_vehicle_models').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }
  if (req.method === 'DELETE') {
    const { error } = await db.from('workshop_vehicle_models').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }
  res.setHeader('Allow', 'PATCH, DELETE')
  return res.status(405).json({ error: 'PATCH or DELETE only' })
})
