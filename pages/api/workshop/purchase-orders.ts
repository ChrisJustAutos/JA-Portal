// pages/api/workshop/purchase-orders.ts
// GET  ?status= — list purchase orders (view:diary)
// POST          — create a PO with line items (edit:bookings)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { recomputePoTotals } from '../../../lib/workshop-po'
import { logWorkshopActivity } from '../../../lib/workshop-activity'

export const config = { maxDuration: 15 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

function lineRows(poId: string, lines: any[]): any[] {
  return (Array.isArray(lines) ? lines : []).map((l, i) => {
    const qty = Number(l.qty) || 0
    const unit = Number(l.unit_cost_ex_gst) || 0
    return {
      po_id: poId,
      inventory_id: l.inventory_id || null,
      myob_item_uid: l.myob_item_uid || null,
      sku: l.sku ? String(l.sku) : null,
      name: String(l.name || l.sku || 'Item').slice(0, 200),
      qty, unit_cost_ex_gst: unit,
      line_total_ex_gst: Math.round(qty * unit * 100) / 100,
      sort_order: i,
    }
  })
}

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const status = String(req.query.status || '').trim()
    let q = db.from('workshop_purchase_orders')
      .select('id, po_seq, supplier_id, supplier_name, status, source, notes, subtotal_ex_gst, gst, total_inc, expected_at, ordered_at, received_at, myob_bill_uid, myob_write_error, created_at')
      .is('deleted_at', null).order('created_at', { ascending: false }).limit(300)
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ purchaseOrders: data || [] })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }

    let supplierName: string | null = body.supplier_name || null
    if (body.supplier_id && !supplierName) {
      const { data: s } = await db.from('workshop_suppliers').select('name').eq('id', body.supplier_id).maybeSingle()
      supplierName = s?.name || null
    }
    const { data: po, error } = await db.from('workshop_purchase_orders').insert({
      supplier_id: body.supplier_id || null,
      supplier_name: supplierName,
      source: ['manual', 'low_stock', 'booking'].includes(body.source) ? body.source : 'manual',
      booking_id: body.booking_id || null,
      notes: body.notes ? String(body.notes) : null,
      expected_at: body.expected_at || null,
      created_by: user.id,
    }).select('id, po_seq').single()
    if (error) return res.status(500).json({ error: error.message })

    const rows = lineRows(po.id, body.lines)
    if (rows.length) {
      const { error: lErr } = await db.from('workshop_po_lines').insert(rows)
      if (lErr) return res.status(500).json({ error: lErr.message })
    }
    await recomputePoTotals(db, po.id)
    await logWorkshopActivity(db, { action: 'created', entity: 'purchase_order', entity_id: po.id, entity_label: `PO-${String(po.po_seq).padStart(4, '0')}`, detail: `Purchase order created${supplierName ? ` for ${supplierName}` : ''}`, actor_id: user.id, actor_name: user.displayName || user.email })
    return res.status(201).json({ ok: true, id: po.id, po_seq: po.po_seq })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})
