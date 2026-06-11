// pages/api/workshop/orders.ts
// Parts-ordering worklist (the Orders screen).
//   GET ?show=pending|ordered&days=N — upcoming active bookings (default 14
//        days ahead, plus anything overdue-unordered in the past 7) with
//        customer/vehicle + their part lines (joined to inventory for stock
//        on hand), filtered to not-yet-ordered (pending) or ordered.
//   POST { booking_id, ordered } — mark / unmark parts ordered (edit:bookings)
//
// "Active" = the booking still needs work done: excludes ready/done/invoiced/
// paid/cancelled/no_show.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { brisbaneDayBounds, addDaysYmd, ymdBrisbane } from '../../../lib/workshop'
import { logWorkshopActivity } from '../../../lib/workshop-activity'

export const config = { maxDuration: 15 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

const ACTIVE_STATUSES = ['prebooked', 'booking', 'confirmed', 'prepared', 'in_progress', 'awaiting_parts']

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const show = req.query.show === 'ordered' ? 'ordered' : 'pending'
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14))
    const today = ymdBrisbane(new Date())
    const fromIso = brisbaneDayBounds(addDaysYmd(today, -7)).fromIso
    const toIso = brisbaneDayBounds(addDaysYmd(today, days)).toIso

    let qy = db.from('workshop_bookings')
      .select('id, starts_at, ends_at, status, job_type, description, technician_ext, estimated_value, parts_ordered_at, parts_ordered_by, customer:workshop_customers(id, name, mobile, phone), vehicle:workshop_vehicles(id, rego, make, model, year)')
      .in('status', ACTIVE_STATUSES)
      .gte('starts_at', fromIso).lt('starts_at', toIso)
      .order('starts_at', { ascending: true })
      .limit(500)
    qy = show === 'pending' ? qy.is('parts_ordered_at', null) : qy.not('parts_ordered_at', 'is', null)
    const { data: bookings, error } = await qy
    if (error) return res.status(500).json({ error: error.message })

    const ids = (bookings || []).map((b: any) => b.id)
    let lines: any[] = []
    if (ids.length) {
      const { data: ld } = await db.from('workshop_booking_lines')
        .select('id, booking_id, line_type, description, part_number, qty, inventory:workshop_inventory(id, sku, part_name, available, on_order)')
        .in('booking_id', ids).eq('line_type', 'part').order('sort_order', { ascending: true })
      lines = ld || []
    }
    const byBooking: Record<string, any[]> = {}
    for (const l of lines) (byBooking[l.booking_id] ||= []).push(l)
    return res.status(200).json({
      bookings: (bookings || []).map((b: any) => ({ ...b, part_lines: byBooking[b.id] || [] })),
    })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const bookingId = String(body.booking_id || '').trim()
    if (!bookingId) return res.status(400).json({ error: 'booking_id required' })
    const ordered = !!body.ordered
    const { error } = await db.from('workshop_bookings').update({
      parts_ordered_at: ordered ? new Date().toISOString() : null,
      parts_ordered_by: ordered ? (user.displayName || user.email || user.id) : null,
      updated_at: new Date().toISOString(),
    }).eq('id', bookingId)
    if (error) return res.status(500).json({ error: error.message })
    await logWorkshopActivity(db, {
      action: 'updated', entity: 'booking', entity_id: bookingId,
      detail: ordered ? 'Parts marked ordered' : 'Parts-ordered mark removed',
      actor_id: user.id, actor_name: user.displayName || null,
    })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
