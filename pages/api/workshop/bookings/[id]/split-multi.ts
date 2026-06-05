// pages/api/workshop/bookings/[id]/split-multi.ts
// POST — split a booking into N segments (parts) across technicians/time.
// Body: { segments: [{ technician_ext?, starts_at, ends_at, description? }] } (>=2).
// The source booking becomes segment 1 (its time/tech/description are updated);
// segments 2..N are created as siblings sharing a split_group_id. Inherits
// customer/vehicle/bay/service_type/job_type/status from the source.
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

  const segments: any[] = Array.isArray(body.segments) ? body.segments : []
  if (segments.length < 2) return res.status(400).json({ error: 'At least two segments are required' })
  for (const s of segments) {
    if (!s.starts_at || !s.ends_at) return res.status(400).json({ error: 'Each segment needs starts_at and ends_at' })
    if (new Date(s.ends_at).getTime() <= new Date(s.starts_at).getTime()) return res.status(400).json({ error: 'Each segment must end after it starts' })
  }

  const db = sb()
  const { data: src, error } = await db.from('workshop_bookings')
    .select('id, customer_id, vehicle_id, bay, service_type, job_type, description, status, split_group_id')
    .eq('id', id).maybeSingle()
  if (error) return res.status(500).json({ error: error.message })
  if (!src) return res.status(404).json({ error: 'Booking not found' })

  const groupId = (src as any).split_group_id || randomUUID()
  const now = new Date().toISOString()

  // Segment 1 → update the source booking in place.
  const s0 = segments[0]
  const { error: upErr } = await db.from('workshop_bookings').update({
    starts_at: s0.starts_at,
    ends_at: s0.ends_at,
    technician_ext: s0.technician_ext ? String(s0.technician_ext) : null,
    description: s0.description != null ? String(s0.description) : (src as any).description,
    split_group_id: groupId,
    updated_at: now,
  }).eq('id', id)
  if (upErr) return res.status(500).json({ error: upErr.message })

  // Segments 2..N → new sibling bookings.
  const rows = segments.slice(1).map(s => ({
    customer_id: (src as any).customer_id,
    vehicle_id: (src as any).vehicle_id,
    starts_at: s.starts_at,
    ends_at: s.ends_at,
    technician_ext: s.technician_ext ? String(s.technician_ext) : null,
    bay: (src as any).bay || null,
    service_type: (src as any).service_type || null,
    job_type: (src as any).job_type || 'general_service',
    description: s.description != null ? String(s.description) : (src as any).description,
    status: (src as any).status || 'booking',
    split_group_id: groupId,
    created_by: user.id,
  }))
  const { data: created, error: insErr } = await db.from('workshop_bookings').insert(rows).select('id')
  if (insErr) return res.status(500).json({ error: insErr.message })

  return res.status(200).json({ ok: true, split_group_id: groupId, segments: segments.length, created: (created || []).map((r: any) => r.id) })
})
