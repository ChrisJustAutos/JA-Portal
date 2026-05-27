// pages/api/workshop/bookings.ts
// GET  ?from=ISO&to=ISO   — bookings whose start falls in [from, to), joined to
//                           customer + vehicle for the diary. Gated view:diary.
// POST                    — create a booking. Gated edit:bookings.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { BOOKING_STATUSES, BookingStatus } from '../../../lib/workshop'
import { queueBookingReminder } from '../../../lib/workshop-reminders'

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
    const from = String(req.query.from || '')
    const to = String(req.query.to || '')
    if (!from || !to) return res.status(400).json({ error: 'from and to (ISO) required' })
    const [bRes, tRes] = await Promise.all([
      db.from('workshop_bookings')
        .select(`id, customer_id, vehicle_id, starts_at, ends_at, technician_ext, bay, service_type, status, notes,
                 job_type, description, internal_notes, estimated_value, span_techs, is_overdue,
                 customer:workshop_customers(id, name, phone, mobile),
                 vehicle:workshop_vehicles(id, rego, make, model, year)`)
        .gte('starts_at', from)
        .lt('starts_at', to)
        .order('starts_at', { ascending: true }),
      db.from('extensions').select('extension, display_name, role').eq('active', true).order('extension', { ascending: true }),
    ])
    if (bRes.error) return res.status(500).json({ error: bRes.error.message })
    const technicians = (tRes.data || [])
      .filter((e: any) => !['system', 'test'].includes(String(e.role || '').toLowerCase()))
      .map((e: any) => ({ ext: String(e.extension), name: e.display_name || `Ext ${e.extension}` }))
    return res.status(200).json({ bookings: bRes.data || [], technicians })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden — cannot edit bookings' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }

    const starts_at = String(body.starts_at || '')
    const ends_at = String(body.ends_at || '')
    if (!starts_at || !ends_at) return res.status(400).json({ error: 'starts_at and ends_at required' })
    const status: BookingStatus = BOOKING_STATUSES.includes(body.status) ? body.status : 'prebooked'

    const { data, error } = await db.from('workshop_bookings').insert({
      customer_id: body.customer_id || null,
      vehicle_id: body.vehicle_id || null,
      starts_at,
      ends_at,
      technician_ext: body.technician_ext ? String(body.technician_ext) : null,
      span_techs: body.span_techs ? String(body.span_techs) : null,
      bay: body.bay ? String(body.bay) : null,
      service_type: body.service_type ? String(body.service_type) : null,
      job_type: body.job_type ? String(body.job_type) : 'general_service',
      description: body.description ? String(body.description) : null,
      internal_notes: body.internal_notes ? String(body.internal_notes) : null,
      estimated_value: typeof body.estimated_value === 'number' ? body.estimated_value
        : (body.estimated_value ? Number(body.estimated_value) || null : null),
      status,
      notes: body.notes ? String(body.notes) : null,
      created_by: user.id,
    }).select('id').single()
    if (error) return res.status(500).json({ error: error.message })
    await queueBookingReminder(data.id)  // best-effort SMS reminder (gated by sms_enabled at send time)
    return res.status(201).json({ ok: true, id: data.id })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
