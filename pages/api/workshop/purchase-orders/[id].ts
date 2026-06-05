// pages/api/workshop/purchase-orders/[id].ts
// GET    — PO + supplier + lines
// PATCH  — update fields / replace lines / change status. Moving to 'received'
//          attempts a MYOB Purchase Bill push (best-effort, gated). (edit:bookings)
// DELETE — soft-delete (edit:bookings)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { recomputePoTotals, pushPurchaseBillToMyob, PoMyobError } from '../../../../lib/workshop-po'
import { logWorkshopActivity } from '../../../../lib/workshop-activity'

export const config = { maxDuration: 30 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

const STATUSES = ['draft', 'sent', 'received', 'cancelled']

function lineRows(poId: string, lines: any[]): any[] {
  return (Array.isArray(lines) ? lines : []).map((l, i) => {
    const qty = Number(l.qty) || 0, unit = Number(l.unit_cost_ex_gst) || 0
    return { po_id: poId, inventory_id: l.inventory_id || null, myob_item_uid: l.myob_item_uid || null, sku: l.sku ? String(l.sku) : null, name: String(l.name || l.sku || 'Item').slice(0, 200), qty, unit_cost_ex_gst: unit, line_total_ex_gst: Math.round(qty * unit * 100) / 100, sort_order: i }
  })
}

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'GET') {
    const { data: po, error } = await db.from('workshop_purchase_orders')
      .select('*, supplier:workshop_suppliers(id, name, myob_supplier_uid, email, phone)')
      .eq('id', id).is('deleted_at', null).maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!po) return res.status(404).json({ error: 'Not found' })
    const { data: lines } = await db.from('workshop_po_lines').select('*').eq('po_id', id).order('sort_order', { ascending: true })
    return res.status(200).json({ po, lines: lines || [] })
  }

  if (req.method === 'PATCH') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }

    const { data: before } = await db.from('workshop_purchase_orders').select('status, po_seq, supplier_name').eq('id', id).maybeSingle()
    if (!before) return res.status(404).json({ error: 'Not found' })

    const patch: any = {}
    if ('supplier_id' in body) patch.supplier_id = body.supplier_id || null
    if ('supplier_name' in body) patch.supplier_name = body.supplier_name || null
    if ('notes' in body) patch.notes = body.notes ? String(body.notes) : null
    if ('expected_at' in body) patch.expected_at = body.expected_at || null
    let statusChanged = false
    if ('status' in body && STATUSES.includes(body.status) && body.status !== before.status) {
      patch.status = body.status
      statusChanged = true
      const now = new Date().toISOString()
      if (body.status === 'sent') patch.ordered_at = now
      if (body.status === 'received') patch.received_at = now
    }
    if (Object.keys(patch).length) {
      const { error } = await db.from('workshop_purchase_orders').update(patch).eq('id', id)
      if (error) return res.status(500).json({ error: error.message })
    }
    if ('lines' in body) {
      await db.from('workshop_po_lines').delete().eq('po_id', id)
      const rows = lineRows(id, body.lines)
      if (rows.length) { const { error: lErr } = await db.from('workshop_po_lines').insert(rows); if (lErr) return res.status(500).json({ error: lErr.message }) }
      await recomputePoTotals(db, id)
    }

    // On receive, attempt the MYOB Purchase Bill push (best-effort).
    let myobPush: { ok: boolean; error?: string; number?: string | null } | undefined
    if (statusChanged && body.status === 'received') {
      try {
        const r = await pushPurchaseBillToMyob(id, user.id)
        myobPush = { ok: true, number: r.myob_number }
      } catch (e: any) {
        if (e instanceof PoMyobError && e.code === 'posting_disabled') myobPush = { ok: false, error: 'MYOB posting is off — received locally only.' }
        else { const msg = e?.message || 'MYOB push failed'; await db.from('workshop_purchase_orders').update({ myob_write_error: String(msg).slice(0, 400) }).eq('id', id); myobPush = { ok: false, error: msg } }
      }
    }
    if (statusChanged) {
      await logWorkshopActivity(db, { action: body.status === 'received' ? 'received' : body.status === 'cancelled' ? 'deleted' : 'status', entity: 'purchase_order', entity_id: id, entity_label: `PO-${String(before.po_seq).padStart(4, '0')}`, detail: `PO ${body.status}${before.supplier_name ? ` · ${before.supplier_name}` : ''}`, actor_id: user.id, actor_name: user.displayName || user.email })
    }
    return res.status(200).json({ ok: true, myobPush })
  }

  if (req.method === 'DELETE') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    const { error } = await db.from('workshop_purchase_orders').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, PATCH or DELETE only' })
})
