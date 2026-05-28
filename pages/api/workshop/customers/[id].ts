// pages/api/workshop/customers/[id].ts
// GET — full customer record + their vehicles, bookings, invoices, payments.
//       Used by the Customer detail page for the "previous history" view.
// PATCH — admin/edit:bookings can update top-level customer fields.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'

export const config = { maxDuration: 15 }

function sb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

const PATCH_FIELDS = ['name', 'first_name', 'last_name', 'phone', 'mobile', 'email', 'address', 'company', 'customer_type', 'customer_number'] as const

export default withAuth('view:diary', async (req, res, user) => {
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })
  const db = sb()

  if (req.method === 'GET') {
    const [cRes, vRes, bRes, iRes] = await Promise.all([
      db.from('workshop_customers')
        .select('id, name, first_name, last_name, phone, mobile, email, address, company, customer_type, customer_number, md_id, myob_uid, created_at, updated_at')
        .eq('id', id).maybeSingle(),
      db.from('workshop_vehicles')
        .select('id, rego, make, model, year, vin, colour, engine, transmission, odometer, notes')
        .eq('customer_id', id).order('created_at', { ascending: false }),
      db.from('workshop_bookings')
        .select('id, starts_at, ends_at, status, job_type, description, estimated_value, vehicle_id, technician_ext')
        .eq('customer_id', id).order('starts_at', { ascending: false }).limit(200),
      db.from('workshop_invoices')
        .select('id, status, subtotal, gst, total, due_date, created_at, booking_id, md_id, myob_invoice_uid')
        .eq('customer_id', id).order('created_at', { ascending: false }).limit(200),
    ])
    if (cRes.error || !cRes.data) return res.status(404).json({ error: 'Customer not found' })
    return res.status(200).json({
      customer: cRes.data,
      vehicles: vRes.data || [],
      bookings: bRes.data || [],
      invoices: iRes.data || [],
    })
  }

  if (req.method === 'PATCH') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const patch: any = {}
    for (const f of PATCH_FIELDS) if (f in body) patch[f] = body[f] === '' ? null : String(body[f])
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No fields to update' })
    const { error } = await db.from('workshop_customers').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, PATCH')
  return res.status(405).json({ error: 'GET or PATCH only' })
})
