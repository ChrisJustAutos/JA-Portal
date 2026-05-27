// pages/api/workshop/bookings/[id]/split.ts
// POST — split a booking: create a sibling (same customer/vehicle/job_type/
// description) that can go to another technician or time. Both share a
// split_group_id. Body: { technician_ext?, starts_at?, ends_at? } — defaults
// to the source's time, assigned to the given tech (or unassigned).
// Gated edit:bookings.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { withAuth } from '../../../../../lib/authServer'

export const config = { maxDuration: 10 }

function sb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('edit:bookings', async (req, res, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  const db = sb()
  const { data: src, error } = await db.from('workshop_bookings')
    .select('id, customer_id, vehicle_id, starts_at, ends_at, technician_ext, bay, service_type, job_type, description, status, split_group_id')
    .eq('id', id).maybeSingle()
  if (error) return res.status(500).json({ error: error.message })
  if (!src) return res.status(404).json({ error: 'Booking not found' })

  // Ensure a shared split group, stamping the source if it isn't part of one.
  const groupId = (src as any).split_group_id || randomUUID()
  if (!(src as any).split_group_id) {
    await db.from('workshop_bookings').update({ split_group_id: groupId, updated_at: new Date().toISOString() }).eq('id', id)
  }

  const { data: created, error: insErr } = await db.from('workshop_bookings').insert({
    customer_id: (src as any).customer_id,
    vehicle_id: (src as any).vehicle_id,
    starts_at: body.starts_at || (src as any).starts_at,
    ends_at: body.ends_at || (src as any).ends_at,
    technician_ext: body.technician_ext ? String(body.technician_ext) : null,
    bay: (src as any).bay || null,
    service_type: (src as any).service_type || null,
    job_type: (src as any).job_type || 'general_service',
    description: (src as any).description || null,
    status: (src as any).status || 'prebooked',
    split_group_id: groupId,
    created_by: user.id,
  }).select('id').single()
  if (insErr) return res.status(500).json({ error: insErr.message })

  return res.status(201).json({ ok: true, id: created.id, split_group_id: groupId })
})
