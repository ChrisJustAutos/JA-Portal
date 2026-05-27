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
  return res.status(200).json({ items })
})
