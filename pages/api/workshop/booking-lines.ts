// pages/api/workshop/booking-lines.ts
// GET    ?booking_id= — line items for a booking/job
// POST                — add a line                (edit:bookings)
// PATCH  ?id=         — update a line             (edit:bookings)
// DELETE ?id=         — remove a line             (edit:bookings)

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

const LINE_TYPES = ['labour', 'part', 'sublet', 'fee', 'description']
const round2 = (n: number) => Math.round(n * 100) / 100

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const bookingId = String(req.query.booking_id || '').trim()
    if (!bookingId) return res.status(400).json({ error: 'booking_id required' })
    const { data, error } = await db.from('workshop_booking_lines')
      .select('*').eq('booking_id', bookingId).order('sort_order', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ lines: data || [] })
  }

  if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  if (req.method === 'POST') {
    const booking_id = String(body.booking_id || '').trim()
    if (!booking_id) return res.status(400).json({ error: 'booking_id required' })
    const qty = Number(body.qty) || 1
    const unit = Number(body.unit_price_ex_gst) || 0
    const { data, error } = await db.from('workshop_booking_lines').insert({
      booking_id,
      line_type: LINE_TYPES.includes(body.line_type) ? body.line_type : 'labour',
      description: body.description ? String(body.description) : null,
      part_number: body.part_number ? String(body.part_number) : null,
      qty,
      unit_price_ex_gst: unit,
      gst_rate: typeof body.gst_rate === 'number' ? body.gst_rate : 0.10,
      inventory_id: body.inventory_id || null,
      total_ex_gst: round2(qty * unit),
      sort_order: Number(body.sort_order) || 0,
    }).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(201).json({ ok: true, line: data })
  }

  if (req.method === 'PATCH') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const patch: Record<string, any> = {}
    for (const f of ['line_type', 'description', 'part_number', 'qty', 'unit_price_ex_gst', 'gst_rate', 'inventory_id', 'sort_order']) {
      if (f in body) patch[f] = body[f] === '' ? null : body[f]
    }
    if ('qty' in body || 'unit_price_ex_gst' in body) {
      const { data: cur } = await db.from('workshop_booking_lines')
        .select('qty, unit_price_ex_gst').eq('id', id).maybeSingle()
      const qty = 'qty' in body ? Number(body.qty) || 0 : Number((cur as any)?.qty) || 0
      const unit = 'unit_price_ex_gst' in body ? Number(body.unit_price_ex_gst) || 0 : Number((cur as any)?.unit_price_ex_gst) || 0
      patch.total_ex_gst = round2(qty * unit)
    }
    const { error } = await db.from('workshop_booking_lines').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { error } = await db.from('workshop_booking_lines').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, POST, PATCH or DELETE only' })
})
