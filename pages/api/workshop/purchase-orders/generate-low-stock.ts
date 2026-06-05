// pages/api/workshop/purchase-orders/generate-low-stock.ts
// POST — scan inventory for items at/under their alert level, group by supplier,
// and create a draft PO per supplier with suggested order quantities. (edit:bookings)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { recomputePoTotals } from '../../../../lib/workshop-po'
import { logWorkshopActivity } from '../../../../lib/workshop-activity'

export const config = { maxDuration: 30 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:diary', async (req, res, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
  const db = sb()

  const { data: inv, error } = await db.from('workshop_inventory')
    .select('id, sku, part_name, supplier, buy_price, myob_uid, available, allocated, on_order, alert_qty, reorder_qty')
    .gt('alert_qty', 0).limit(5000)
  if (error) return res.status(500).json({ error: error.message })

  // Low = available at or below the alert level.
  const low = (inv || []).filter((r: any) => Number(r.available) <= Number(r.alert_qty))
  if (low.length === 0) return res.status(200).json({ ok: true, created: 0, message: 'Nothing is at or below its alert level.' })

  // Existing suppliers for FK matching by name.
  const { data: suppliers } = await db.from('workshop_suppliers').select('id, name').is('deleted_at', null)
  const supByName = new Map<string, string>((suppliers || []).map((s: any) => [String(s.name).trim().toLowerCase(), s.id]))

  // Group by primary supplier (text; first if comma-separated). Unknown → its own bucket.
  const groups = new Map<string, any[]>()
  for (const r of low) {
    const supplier = String(r.supplier || '').split(',')[0].trim() || 'Unknown supplier'
    if (!groups.has(supplier)) groups.set(supplier, [])
    groups.get(supplier)!.push(r)
  }

  let created = 0
  const summary: { supplier: string; items: number }[] = []
  for (const [supplier, items] of Array.from(groups.entries())) {
    const { data: po, error: pErr } = await db.from('workshop_purchase_orders').insert({
      supplier_id: supByName.get(supplier.toLowerCase()) || null,
      supplier_name: supplier,
      source: 'low_stock',
      notes: 'Auto-generated from low stock',
      created_by: user.id,
    }).select('id, po_seq').single()
    if (pErr) continue
    const rows = items.map((r: any, i: number) => {
      // Order up to the reorder level (fallback: enough to clear the alert), net of what's already on order.
      const target = Number(r.reorder_qty) > 0 ? Number(r.reorder_qty) : Number(r.alert_qty)
      const qty = Math.max(1, Math.ceil(target - Number(r.available) - Number(r.on_order || 0)))
      const unit = Number(r.buy_price) || 0
      return { po_id: po.id, inventory_id: r.id, myob_item_uid: r.myob_uid || null, sku: r.sku || null, name: r.part_name || r.sku || 'Item', qty, unit_cost_ex_gst: unit, line_total_ex_gst: Math.round(qty * unit * 100) / 100, sort_order: i }
    })
    await db.from('workshop_po_lines').insert(rows)
    await recomputePoTotals(db, po.id)
    created++
    summary.push({ supplier, items: items.length })
  }

  await logWorkshopActivity(db, { action: 'created', entity: 'purchase_order', detail: `Generated ${created} draft PO(s) from low stock`, actor_id: user.id, actor_name: user.displayName || user.email })
  return res.status(200).json({ ok: true, created, summary })
})
