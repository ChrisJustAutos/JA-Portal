// pages/api/workshop/inventory.ts
// GET ?q= &low=1 &limit= — search/list active inventory (for the parts picker
//           and the inventory screen). low=1 = at/under alert qty. Gated view:diary.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:diary', async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  const q = String(req.query.q || '').trim().replace(/[%,()*]/g, ' ').trim()
  const low = String(req.query.low || '') === '1'
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 500)
  const db = sb()
  let query = db.from('workshop_inventory')
    .select('id, myob_uid, sku, part_name, brand, category, supplier, sell_price, buy_price, quantity, available, allocated, on_order, alert_qty, reorder_qty, location, bin')
    .eq('deactivated', false)
    .order('part_name', { ascending: true })
    .limit(limit)
  if (q) query = query.or(`sku.ilike.%${q}%,part_name.ilike.%${q}%,brand.ilike.%${q}%,barcode.ilike.%${q}%`)
  if (low) query = query.gt('alert_qty', 0)
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  // PostgREST can't compare two columns, so apply the available<=alert_qty
  // low-stock test here.
  const items = low ? (data || []).filter((r: any) => Number(r.available) <= Number(r.alert_qty)) : (data || [])

  // Optional date range: how many of each part were allocated to jobs in the
  // window (sum of part-line qty on bookings whose start falls in the range).
  const from = String(req.query.from || '').trim()
  const to = String(req.query.to || '').trim()
  if (from && to && items.length) {
    try {
      const fromIso = new Date(`${from}T00:00:00+10:00`).toISOString()
      const toIso = new Date(new Date(`${to}T00:00:00+10:00`).getTime() + 86400000).toISOString() // inclusive end day
      const ids = items.map((i: any) => i.id)
      const { data: lines } = await db.from('workshop_booking_lines')
        .select('inventory_id, qty, booking:workshop_bookings!inner(starts_at)')
        .in('inventory_id', ids).eq('line_type', 'part')
        .gte('booking.starts_at', fromIso).lt('booking.starts_at', toIso)
      const sums: Record<string, number> = {}
      for (const l of (lines as any[]) || []) { if (!l.inventory_id) continue; sums[l.inventory_id] = (sums[l.inventory_id] || 0) + (Number(l.qty) || 0) }
      for (const it of items as any[]) it.allocated_period = sums[it.id] || 0
    } catch { /* range allocation is best-effort */ }
  }

  return res.status(200).json({ items })
})
