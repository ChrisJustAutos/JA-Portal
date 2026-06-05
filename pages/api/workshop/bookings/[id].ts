// pages/api/workshop/bookings/[id].ts
// GET   — the full job card: the booking (all fields) + customer + vehicle +
//         its line items + the vehicle's prior service history. Gated view:diary.
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

const EDITABLE = [
  'starts_at', 'ends_at', 'technician_ext', 'span_techs', 'bay', 'service_type', 'notes', 'customer_id', 'vehicle_id',
  'job_type', 'description', 'internal_notes', 'estimated_value', 'odometer', 'summary', 'is_overdue', 'pickup_at', 'checklist',
] as const

export default withAuth('view:diary', async (req, res, user) => {
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  const db = sb()

  if (req.method === 'GET') {
    const { data: booking, error } = await db
      .from('workshop_bookings')
      .select(`*, customer:workshop_customers(*), vehicle:workshop_vehicles(*)`)
      .eq('id', id)
      .maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!booking) return res.status(404).json({ error: 'not_found' })

    const { data: lines } = await db
      .from('workshop_booking_lines')
      .select('*')
      .eq('booking_id', id)
      .order('sort_order', { ascending: true })

    let history: any[] = []
    if ((booking as any).vehicle_id) {
      const { data: h } = await db
        .from('workshop_bookings')
        .select('id, starts_at, completed_at, status, job_type, description, summary, odometer, total_inc_gst')
        .eq('vehicle_id', (booking as any).vehicle_id)
        .neq('id', id)
        .in('status', ['done', 'invoiced', 'paid'])
        .order('starts_at', { ascending: false })
        .limit(50)
      history = h || []
    }
    return res.status(200).json({ booking, lines: lines || [], history })
  }

  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'GET, PATCH')
    return res.status(405).json({ error: 'GET or PATCH only' })
  }
  if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden — cannot edit bookings' })

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

  const { error } = await db.from('workshop_bookings').update(patch).eq('id', id)
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ ok: true })
})
