// pages/api/workshop/quotes.ts
// GET  ?status=  — list quotes (with customer + vehicle) for the quotes board
// POST           — create a draft quote (edit:bookings)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { logWorkshopActivity } from '../../../lib/workshop-activity'

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
    const status = String(req.query.status || '').trim()
    const view = String(req.query.view || 'active').trim()  // 'active' | 'trash'
    let q = db.from('workshop_quotes')
      .select(`id, quote_seq, status, subtotal, gst, total, notes, created_at, deleted_at,
               customer:workshop_customers!customer_id(id, name),
               vehicle:workshop_vehicles(id, rego, make, model, year)`)
      .order('created_at', { ascending: false })
      .limit(200)
    if (view === 'trash') q = q.not('deleted_at', 'is', null)
    else q = q.is('deleted_at', null)
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    const quotes = data || []
    // ?with_leads=1 — attach the linked CRM lead (CRM quote board chips).
    if (String(req.query.with_leads || '') === '1' && quotes.length) {
      const ids = quotes.map((qt: any) => qt.id)
      const { data: leads } = await db.from('crm_leads')
        .select('id, title, stage, contact_id, workshop_quote_id').in('workshop_quote_id', ids).is('deleted_at', null)
      const byQuote: Record<string, any> = {}
      for (const l of leads || []) byQuote[l.workshop_quote_id] = l
      for (const qt of quotes as any[]) qt.lead = byQuote[qt.id] || null
    }
    return res.status(200).json({ quotes })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const { data, error } = await db.from('workshop_quotes').insert({
      customer_id: body.customer_id || null,
      vehicle_id: body.vehicle_id || null,
      notes: body.notes ? String(body.notes) : null,
      created_by: user.id,
      salesperson_id: body.salesperson_id || user.id,
    }).select('id').single()
    if (error) return res.status(500).json({ error: error.message })
    await logWorkshopActivity(db, { action: 'created', entity: 'quote', entity_id: data.id, detail: 'Quote created', actor_id: user.id, actor_name: user.displayName || user.email })
    return res.status(201).json({ ok: true, id: data.id })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
