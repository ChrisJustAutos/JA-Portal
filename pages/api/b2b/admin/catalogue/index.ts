// pages/api/b2b/admin/catalogue/index.ts
// GET /api/b2b/admin/catalogue
// Returns: { items: CatalogueItem[] }
//
// Lists every catalogue row (no pagination yet — JAWS catalogue is small).
// Each item includes admin-relevant fields plus the latest MYOB sync info
// so the grid can flag stale entries.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('view:b2b', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }

  const c = sb()
  const { data, error } = await c
    .from('b2b_catalogue')
    .select(`
      id,
      myob_item_uid,
      sku,
      name,
      description,
      model_id,
      product_type_id,
      trade_price_ex_gst,
      rrp_ex_gst,
      is_taxable,
      primary_image_url,
      b2b_visible,
      last_synced_from_myob_at,
      created_at,
      updated_at
    `)
    .order('sku', { ascending: true })

  if (error) {
    return res.status(500).json({ error: error.message })
  }

  return res.status(200).json({ items: data || [] })
})
