// pages/api/workshop/quotes/[id]/convert.ts
// POST — turn an accepted quote into a diary job: create a booking from the
//        quote's customer/vehicle/total and copy its lines into booking_lines,
//        then mark the quote 'converted'. Returns the new booking id.
//        Gated edit:bookings.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'
import { roleHasPermission } from '../../../../../lib/permissions'
import { onQuoteConverted } from '../../../../../lib/crm-bridge'
import { enrolFromEvent } from '../../../../../lib/crm-automation-triggers'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

const round2 = (n: number) => Math.round(n * 100) / 100

export default withAuth('view:diary', async (req, res, user) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })

  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  const db = sb()

  const { data: quote, error: qErr } = await db.from('workshop_quotes')
    .select('id, customer_id, vehicle_id, total, notes, status').eq('id', id).maybeSingle()
  if (qErr) return res.status(500).json({ error: qErr.message })
  if (!quote) return res.status(404).json({ error: 'not_found' })

  const { data: qLines } = await db.from('workshop_quote_lines')
    .select('*').eq('quote_id', id).order('sort_order', { ascending: true })

  // Booking starts at the next half-hour slot, 1h long by default.
  const slot = 30 * 60000
  const start = new Date(Math.ceil(Date.now() / slot) * slot)
  const end = new Date(start.getTime() + 60 * 60000)

  const { data: booking, error: bErr } = await db.from('workshop_bookings').insert({
    customer_id: quote.customer_id || null,
    vehicle_id: quote.vehicle_id || null,
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
    status: 'booking',
    job_type: 'general_service',
    description: quote.notes ? String(quote.notes) : 'From quote',
    estimated_value: quote.total || null,
    created_by: user.id,
  }).select('id').single()
  if (bErr) return res.status(500).json({ error: bErr.message })

  const lines = (qLines || []).map((l: any, i: number) => ({
    booking_id: booking.id,
    line_type: (l.inventory_id || l.part_number) ? 'part' : 'labour',
    description: l.description || null,
    part_number: l.part_number || null,
    qty: Number(l.qty) || 1,
    unit_price_ex_gst: Number(l.unit_price) || 0,
    gst_rate: 0.10,
    inventory_id: l.inventory_id || null,
    total_ex_gst: round2((Number(l.qty) || 1) * (Number(l.unit_price) || 0)),
    sort_order: Number(l.sort_order) || i,
  }))
  if (lines.length > 0) {
    const { error: lErr } = await db.from('workshop_booking_lines').insert(lines)
    if (lErr) return res.status(500).json({ error: lErr.message })
  }

  await db.from('workshop_quotes').update({ status: 'converted', updated_at: new Date().toISOString() }).eq('id', id)

  // Reflect on the linked CRM lead: booking activity + configured stage move.
  await onQuoteConverted(db, { id, customer_id: quote.customer_id, total: quote.total }, booking.id, start.toISOString(), user.id)

  // booking_created flow trigger (this insert path bypasses /api/workshop/bookings).
  if (quote.customer_id) {
    const { data: ct } = await db.from('crm_contacts').select('id').eq('workshop_customer_id', quote.customer_id).is('deleted_at', null).maybeSingle()
    if (ct) await enrolFromEvent(db, 'booking_created', { contact_id: ct.id, booking_id: booking.id, dedupe_key: `booking:${booking.id}` })
  }

  return res.status(200).json({ ok: true, booking_id: booking.id })
})
