// pages/api/workshop/jobs.ts
// GET ?q=&status=&limit= — search/list all jobs (workshop_bookings) for the Jobs
// screen. status = 'all' (default) or a comma list of booking statuses. Text
// search spans customer name/phone, vehicle rego/make/model/VIN, job type and
// the job description. Gated view:diary.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'

export const config = { maxDuration: 15 }

function sb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:diary', async (req, res) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const db = sb()

  const raw = String(req.query.q || '').trim()
  const q = raw.replace(/[%,()*]/g, ' ').trim()        // PostgREST or()-safe
  const digits = raw.replace(/\D/g, '')
  const statusParam = String(req.query.status || 'all').trim()
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))

  let query = db.from('workshop_bookings')
    .select('id, starts_at, status, job_type, description, technician_ext, total_inc_gst, estimated_value, parts_ordered_at, customer:workshop_customers!customer_id(id, name, mobile, phone), vehicle:workshop_vehicles(id, rego, make, model, year)')
    .order('starts_at', { ascending: false })
    .limit(limit)

  if (statusParam && statusParam !== 'all') {
    const statuses = statusParam.split(',').map(s => s.trim()).filter(Boolean)
    if (statuses.length) query = query.in('status', statuses)
  }

  if (q) {
    // Resolve matching customers/vehicles first, then OR their ids into the
    // booking filter (PostgREST can't ilike across embedded relations).
    const custOr = [`name.ilike.%${q}%`]
    if (digits.length >= 3) custOr.push(`mobile.ilike.%${digits}%`, `phone.ilike.%${digits}%`)
    const [custRes, vehRes] = await Promise.all([
      db.from('workshop_customers').select('id').or(custOr.join(',')).limit(300),
      db.from('workshop_vehicles').select('id').or(`rego.ilike.%${q}%,make.ilike.%${q}%,model.ilike.%${q}%,vin.ilike.%${q}%`).limit(300),
    ])
    const custIds = (custRes.data || []).map((c: any) => c.id)
    const vehIds = (vehRes.data || []).map((v: any) => v.id)
    const ors = [`description.ilike.%${q}%`, `job_type.ilike.%${q}%`]
    if (custIds.length) ors.push(`customer_id.in.(${custIds.join(',')})`)
    if (vehIds.length) ors.push(`vehicle_id.in.(${vehIds.join(',')})`)
    query = query.or(ors.join(','))
  }

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ jobs: data || [] })
})
