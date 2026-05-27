// pages/api/workshop/inventory.ts
// GET ?q= — search active inventory items (max 20), for the job-card parts
//           picker. Gated view:diary. (Sync from MYOB lands in a later pass.)

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
  const db = sb()
  let query = db.from('workshop_inventory')
    .select('id, sku, part_name, brand, sell_price, buy_price, available, location, bin')
    .eq('deactivated', false)
    .order('part_name', { ascending: true })
    .limit(20)
  if (q) query = query.or(`sku.ilike.%${q}%,part_name.ilike.%${q}%,brand.ilike.%${q}%,barcode.ilike.%${q}%`)
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ items: data || [] })
})
