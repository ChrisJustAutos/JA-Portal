// pages/api/workshop/bookings/[id].ts
// PATCH — update a booking (move time, reassign tech/bay, change status, edit
//         details). Gated edit:bookings.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { BOOKING_STATUSES } from '../../../../lib/workshop'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

const EDITABLE = ['starts_at', 'ends_at', 'technician_ext', 'bay', 'service_type', 'notes', 'customer_id', 'vehicle_id'] as const

export default withAuth('view:diary', async (req, res, user) => {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH')
    return res.status(405).json({ error: 'PATCH only' })
  }
  if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden — cannot edit bookings' })

  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  const patch: Record<string, any> = { updated_at: new Date().toISOString() }
  for (const f of EDITABLE) {
    if (f in body) patch[f] = body[f] === '' ? null : body[f]
  }
  if ('status' in body) {
    if (!BOOKING_STATUSES.includes(body.status)) return res.status(400).json({ error: 'invalid status' })
    patch.status = body.status
  }

  const db = sb()
  const { error } = await db.from('workshop_bookings').update(patch).eq('id', id)
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ ok: true })
})
