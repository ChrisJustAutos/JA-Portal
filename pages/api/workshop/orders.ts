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

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { brisbaneDayBounds, addDaysYmd, ymdBrisbane } from '../../../lib/workshop'
import { logWorkshopActivity } from '../../../lib/workshop-activity'
import { recomputePoTotals } from '../../../lib/workshop-po'

export const config = { maxDuration: 30 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

const ACTIVE_STATUSES = ['prebooked', 'booking', 'confirmed', 'prepared', 'in_progress', 'awaiting_parts']

// A booking's parts are "ordered" once every part line is ordered. Auto-set the
// booking flag when that happens (never auto-clear — booking-level unmark does).
async function autoSetBookingsOrdered(db: SupabaseClient, bookingIds: string[], actor: string) {
  for (const bid of Array.from(new Set(bookingIds))) {
    const { data: lines } = await db.from('workshop_booking_lines')
      .select('ordered_at').eq('booking_id', bid).eq('line_type', 'part')
    if (!lines || !lines.length) continue
    if (!lines.every((l: any) => l.ordered_at)) continue
    const { data: bk } = await db.from('workshop_bookings').select('parts_ordered_at').eq('id', bid).maybeSingle()
    if (!bk?.parts_ordered_at) {
      await db.from('workshop_bookings').update({
        parts_ordered_at: new Date().toISOString(), parts_ordered_by: actor, updated_at: new Date().toISOString(),
      }).eq('id', bid)
    }
  }
}

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const show = req.query.show === 'ordered' ? 'ordered' : 'pending'
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14))
    const today = ymdBrisbane(new Date())
    const fromIso = brisbaneDayBounds(addDaysYmd(today, -7)).fromIso
    const toIso = brisbaneDayBounds(addDaysYmd(today, days)).toIso

    let qy = db.from('workshop_bookings')
      .select('id, starts_at, ends_at, status, job_type, description, technician_ext, estimated_value, parts_ordered_at, parts_ordered_by, customer:workshop_customers!customer_id(id, name, mobile, phone), vehicle:workshop_vehicles(id, rego, make, model, year)')
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
        .select('id, booking_id, line_type, description, part_number, qty, ordered_at, ordered_by, po_id, inventory:workshop_inventory(id, sku, part_name, supplier, buy_price, myob_uid, available, on_order)')
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
    const actor = user.displayName || user.email || user.id
    const action = String(body.action || '')

    // ── Mark / unmark individual part lines ordered ───────────────────────
    if (action === 'mark_lines') {
      const lineIds: string[] = Array.isArray(body.line_ids) ? body.line_ids.map(String) : []
      if (!lineIds.length) return res.status(400).json({ error: 'line_ids required' })
      const ordered = body.ordered !== false
      const { data: lines } = await db.from('workshop_booking_lines').select('id, booking_id').in('id', lineIds)
      const { error } = await db.from('workshop_booking_lines').update({
        ordered_at: ordered ? new Date().toISOString() : null,
        ordered_by: ordered ? actor : null,
      }).in('id', lineIds)
      if (error) return res.status(500).json({ error: error.message })
      const bookingIds = (lines || []).map((l: any) => l.booking_id)
      if (ordered) await autoSetBookingsOrdered(db, bookingIds, actor)
      return res.status(200).json({ ok: true })
    }

    // ── Create draft PO(s) from selected part lines (grouped by supplier) ──
    if (action === 'create_po') {
      const lineIds: string[] = Array.isArray(body.line_ids) ? body.line_ids.map(String) : []
      if (!lineIds.length) return res.status(400).json({ error: 'line_ids required' })
      const { data: lines } = await db.from('workshop_booking_lines')
        .select('id, booking_id, description, part_number, qty, po_id, inventory:workshop_inventory(id, sku, part_name, supplier, buy_price, myob_uid)')
        .in('id', lineIds).eq('line_type', 'part')
      const open = (lines || []).filter((l: any) => !l.po_id)
      if (!open.length) return res.status(400).json({ error: 'Those lines are already on a purchase order.' })

      const { data: suppliers } = await db.from('workshop_suppliers').select('id, name').is('deleted_at', null)
      const supByName = new Map<string, string>((suppliers || []).map((s: any) => [String(s.name).trim().toLowerCase(), s.id]))

      // Group lines by their part's primary supplier (text).
      const groups = new Map<string, any[]>()
      for (const l of open) {
        const inv: any = Array.isArray(l.inventory) ? l.inventory[0] : l.inventory
        const supplier = String(inv?.supplier || '').split(',')[0].trim() || 'Unknown supplier'
        if (!groups.has(supplier)) groups.set(supplier, [])
        groups.get(supplier)!.push({ ...l, inv })
      }

      const created: { supplier: string; po_id: string; po_seq: number; items: number }[] = []
      const affectedBookings: string[] = []
      for (const [supplier, items] of Array.from(groups.entries())) {
        const { data: po, error: pErr } = await db.from('workshop_purchase_orders').insert({
          supplier_id: supByName.get(supplier.toLowerCase()) || null,
          supplier_name: supplier, source: 'booking',
          notes: 'Created from parts orders', created_by: user.id,
        }).select('id, po_seq').single()
        if (pErr || !po) continue
        const rows = items.map((l: any, i: number) => {
          const qty = Math.max(1, Number(l.qty) || 1)
          const unit = Number(l.inv?.buy_price) || 0
          return {
            po_id: po.id, inventory_id: l.inv?.id || null, myob_item_uid: l.inv?.myob_uid || null,
            sku: l.inv?.sku || l.part_number || null, name: l.inv?.part_name || l.description || 'Part',
            qty, unit_cost_ex_gst: unit, line_total_ex_gst: Math.round(qty * unit * 100) / 100, sort_order: i,
          }
        })
        await db.from('workshop_po_lines').insert(rows)
        await recomputePoTotals(db, po.id)
        // Link + mark the booking lines ordered.
        await db.from('workshop_booking_lines').update({
          po_id: po.id, ordered_at: new Date().toISOString(), ordered_by: actor,
        }).in('id', items.map((l: any) => l.id))
        for (const l of items) affectedBookings.push(l.booking_id)
        created.push({ supplier, po_id: po.id, po_seq: po.po_seq, items: items.length })
      }
      await autoSetBookingsOrdered(db, affectedBookings, actor)
      await logWorkshopActivity(db, { action: 'created', entity: 'purchase_order', detail: `Created ${created.length} PO(s) from parts orders`, actor_id: user.id, actor_name: actor })
      return res.status(200).json({ ok: true, created })
    }

    // ── Mark / unmark the whole booking (coarse control) ──────────────────
    const bookingId = String(body.booking_id || '').trim()
    if (!bookingId) return res.status(400).json({ error: 'booking_id required' })
    const ordered = !!body.ordered
    const { error } = await db.from('workshop_bookings').update({
      parts_ordered_at: ordered ? new Date().toISOString() : null,
      parts_ordered_by: ordered ? actor : null,
      updated_at: new Date().toISOString(),
    }).eq('id', bookingId)
    if (error) return res.status(500).json({ error: error.message })
    // Keep line state consistent: marking stamps all part lines; unmarking
    // clears lines that aren't tied to a PO.
    if (ordered) {
      await db.from('workshop_booking_lines').update({ ordered_at: new Date().toISOString(), ordered_by: actor })
        .eq('booking_id', bookingId).eq('line_type', 'part').is('ordered_at', null)
    } else {
      await db.from('workshop_booking_lines').update({ ordered_at: null, ordered_by: null })
        .eq('booking_id', bookingId).eq('line_type', 'part').is('po_id', null)
    }
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
