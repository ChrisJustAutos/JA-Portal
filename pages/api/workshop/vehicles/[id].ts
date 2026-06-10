// pages/api/workshop/vehicles/[id].ts
// GET — vehicle detail for the Vehicles screen: vehicle + owner + service
//       history (bookings) + invoices (joined via booking_id — invoices have
//       no vehicle_id) + attached files. Gated view:diary.
// (Edits go through PATCH /api/workshop/vehicles?id=, one whitelist owner.)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'

export const config = { maxDuration: 15 }

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default withAuth('view:diary', async (req, res) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  const db = sb()

  const { data: vehicle, error } = await db.from('workshop_vehicles')
    .select('*, customer:workshop_customers(id, name, mobile, phone, email)')
    .eq('id', id).maybeSingle()
  if (error) return res.status(500).json({ error: error.message })
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' })

  const { data: bookings } = await db.from('workshop_bookings')
    .select('id, starts_at, completed_at, status, job_type, description, summary, odometer, total_inc_gst, technician_ext')
    .eq('vehicle_id', id)
    .order('starts_at', { ascending: false }).limit(200)

  const bookingIds = (bookings || []).map((b: any) => b.id)
  let invoices: any[] = []
  if (bookingIds.length) {
    const { data } = await db.from('workshop_invoices')
      .select('id, booking_id, status, total, created_at, md_id, deleted_at')
      .in('booking_id', bookingIds).is('deleted_at', null)
      .order('created_at', { ascending: false })
    invoices = data || []
  }

  const { data: files } = await db.from('workshop_files')
    .select('id, file_name, mime_type, size_bytes, uploaded_by_name, created_at')
    .eq('vehicle_id', id).order('created_at', { ascending: false }).limit(100)

  return res.status(200).json({ vehicle, bookings: bookings || [], invoices, files: files || [] })
})
