// pages/api/workshop/vehicles.ts
// GET  ?customer_id=  — vehicles for a customer
//      ?q=            — search by rego / make / model (max 20)
// POST                — quick-create a vehicle (edit:bookings).

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
    const id = String(req.query.id || '').trim()
    if (id) {
      const { data, error } = await db.from('workshop_vehicles')
        .select('id, customer_id, rego, make, model, year, vin, odometer, model_id').eq('id', id).maybeSingle()
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ vehicle: data || null })
    }
    const customerId = String(req.query.customer_id || '').trim()
    const q = String(req.query.q || '').trim().replace(/[%,()*]/g, ' ').trim()
    let query = db.from('workshop_vehicles')
      .select('id, customer_id, rego, make, model, year, vin, odometer, model_id')
      .order('rego', { ascending: true })
      .limit(20)
    if (customerId) query = query.eq('customer_id', customerId)
    if (q) query = query.or(`rego.ilike.%${q}%,make.ilike.%${q}%,model.ilike.%${q}%`)
    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ vehicles: data || [] })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }

    const hasAny = ['rego', 'make', 'model', 'vin'].some(f => String(body[f] || '').trim())
    if (!hasAny) return res.status(400).json({ error: 'at least one of rego/make/model/vin required' })
    const yearNum = body.year ? parseInt(String(body.year), 10) : null
    const odoNum = body.odometer ? parseInt(String(body.odometer), 10) : null

    const { data, error } = await db.from('workshop_vehicles').insert({
      customer_id: body.customer_id || null,
      rego: body.rego ? String(body.rego).trim().toUpperCase() : null,
      make: body.make ? String(body.make) : null,
      model: body.model ? String(body.model) : null,
      year: yearNum && isFinite(yearNum) ? yearNum : null,
      vin: body.vin ? String(body.vin) : null,
      colour: body.colour ? String(body.colour) : null,
      odometer: odoNum && isFinite(odoNum) ? odoNum : null,
      notes: body.notes ? String(body.notes) : null,
      model_id: body.model_id || null,
    }).select('id, rego, make, model, year, model_id').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ ok: true, vehicle: data })
  }

  if (req.method === 'PATCH') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const id = String(req.query.id || body.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const patch: any = {}
    if ('model_id' in body) patch.model_id = body.model_id || null
    if ('rego' in body) patch.rego = body.rego ? String(body.rego).trim().toUpperCase() : null
    if ('make' in body) patch.make = body.make ? String(body.make) : null
    if ('model' in body) patch.model = body.model ? String(body.model) : null
    if ('year' in body) { const y = parseInt(String(body.year), 10); patch.year = isFinite(y) ? y : null }
    if ('odometer' in body) { const o = parseInt(String(body.odometer), 10); patch.odometer = isFinite(o) ? o : null }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No fields' })
    const { error } = await db.from('workshop_vehicles').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, PATCH')
  return res.status(405).json({ error: 'GET, POST or PATCH only' })
})
