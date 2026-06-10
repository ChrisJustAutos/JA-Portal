// pages/api/workshop/vehicles.ts
// GET  ?customer_id=  — vehicles for a customer
//      ?q=            — search by rego / make / model (max 20, picker-style)
//      ?list=1[&q=&due=soon|overdue&limit=&offset=&count=1]
//                     — paginated Vehicles screen list w/ customer join;
//                       q also matches VIN + customer name; due filters on
//                       service/rego due dates (lead = service_reminder_lead_days)
// POST                — quick-create a vehicle (edit:bookings).
// PATCH ?id=          — edit (incl. service/rego due fields).

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { cancelVehicleDueReminders } from '../../../lib/workshop-reminders'
import { ymdBrisbane, addDaysYmd } from '../../../lib/workshop'

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
        .select('id, customer_id, rego, make, model, year, vin, odometer, model_id, next_service_due_date, next_service_due_km, rego_due_date').eq('id', id).maybeSingle()
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ vehicle: data || null })
    }
    // ── Vehicles screen list mode ──
    if (String(req.query.list || '') === '1') {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
      const offset = Math.max(0, Number(req.query.offset) || 0)
      const due = String(req.query.due || '')
      const q2 = String(req.query.q || '').trim().replace(/[%,()*]/g, ' ').trim()
      const SELECT = `id, customer_id, rego, make, model, year, vin, colour, odometer, model_id,
                      next_service_due_date, next_service_due_km, rego_due_date,
                      customer:workshop_customers(id, name, mobile, phone)`

      let dueOr: string | null = null
      const today = ymdBrisbane(new Date())
      if (due === 'overdue') dueOr = `next_service_due_date.lt.${today},rego_due_date.lt.${today}`
      else if (due === 'soon') {
        const { data: s } = await db.from('workshop_settings').select('service_reminder_lead_days').eq('id', 'singleton').maybeSingle()
        const cutoff = addDaysYmd(today, Number(s?.service_reminder_lead_days ?? 14))
        dueOr = `next_service_due_date.lte.${cutoff},rego_due_date.lte.${cutoff}`
      }

      if (q2) {
        // Two passes merged in JS: vehicle fields + owner-name match.
        let vq = db.from('workshop_vehicles').select(SELECT)
          .or(`rego.ilike.%${q2}%,vin.ilike.%${q2}%,make.ilike.%${q2}%,model.ilike.%${q2}%`)
          .order('rego', { ascending: true }).limit(100)
        if (dueOr) vq = vq.or(dueOr)
        const { data: byVehicle, error: e1 } = await vq
        if (e1) return res.status(500).json({ error: e1.message })
        const { data: custs } = await db.from('workshop_customers').select('id').ilike('name', `%${q2}%`).limit(100)
        let byOwner: any[] = []
        if (custs && custs.length) {
          let oq = db.from('workshop_vehicles').select(SELECT)
            .in('customer_id', custs.map((c: any) => c.id))
            .order('rego', { ascending: true }).limit(100)
          if (dueOr) oq = oq.or(dueOr)
          byOwner = (await oq).data || []
        }
        const seen = new Set<string>()
        const merged = [...(byVehicle || []), ...byOwner].filter((v: any) => { if (seen.has(v.id)) return false; seen.add(v.id); return true })
        if (String(req.query.count || '') === '1') return res.status(200).json({ total: merged.length })
        return res.status(200).json({ vehicles: merged.slice(offset, offset + limit), total: merged.length })
      }

      let qy = db.from('workshop_vehicles').select(SELECT, { count: 'exact' })
        .order('rego', { ascending: true, nullsFirst: false })
        .range(offset, offset + limit - 1)
      if (dueOr) qy = qy.or(dueOr)
      if (String(req.query.count || '') === '1') {
        const { count, error } = await db.from('workshop_vehicles').select('id', { count: 'exact', head: true }).or(dueOr || 'id.not.is.null')
        if (error) return res.status(500).json({ error: error.message })
        return res.status(200).json({ total: count || 0 })
      }
      const { data, count, error } = await qy
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ vehicles: data || [], total: count || 0 })
    }

    const customerId = String(req.query.customer_id || '').trim()
    const q = String(req.query.q || '').trim().replace(/[%,()*]/g, ' ').trim()
    let query = db.from('workshop_vehicles')
      .select('id, customer_id, rego, make, model, year, vin, odometer, model_id, next_service_due_date, next_service_due_km, rego_due_date')
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
    if ('vin' in body) patch.vin = body.vin ? String(body.vin).trim() : null
    if ('colour' in body) patch.colour = body.colour ? String(body.colour) : null
    if ('notes' in body) patch.notes = body.notes ? String(body.notes) : null
    if ('customer_id' in body) patch.customer_id = body.customer_id || null
    // Service-due fields (086). Clearing a due date also cancels any pending
    // queued SMS for it so a stale reminder can't fire.
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
    if ('next_service_due_date' in body) patch.next_service_due_date = DATE_RE.test(String(body.next_service_due_date || '')) ? body.next_service_due_date : null
    if ('rego_due_date' in body) patch.rego_due_date = DATE_RE.test(String(body.rego_due_date || '')) ? body.rego_due_date : null
    if ('next_service_due_km' in body) { const k = parseInt(String(body.next_service_due_km), 10); patch.next_service_due_km = isFinite(k) && k > 0 ? k : null }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No fields' })
    const { error } = await db.from('workshop_vehicles').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    if ('next_service_due_date' in patch && !patch.next_service_due_date) await cancelVehicleDueReminders(id, 'service_due')
    if ('rego_due_date' in patch && !patch.rego_due_date) await cancelVehicleDueReminders(id, 'rego_due')
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, PATCH')
  return res.status(405).json({ error: 'GET, POST or PATCH only' })
})
