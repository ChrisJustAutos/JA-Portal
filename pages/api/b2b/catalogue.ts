// pages/api/b2b/catalogue.ts
//
// GET /api/b2b/catalogue
//
// Returns visible catalogue items for the signed-in distributor user,
// each with current stock state pulled from b2b-stock cache.
//
// Hides admin-only fields (cost, RRP source, last_synced_from_myob_at,
// myob_item_uid, etc.) — distributors only see what they need to browse.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../lib/b2bAuthServer'
import { getStockForItems, stockState, StockState } from '../../../lib/b2b-stock'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

interface PublicCatalogueItem {
  id: string
  sku: string
  name: string
  description: string | null
  trade_price_ex_gst: number
  rrp_ex_gst: number | null
  is_taxable: boolean
  primary_image_url: string | null
  category_id: string | null
  stock: {
    state: StockState
    qty_available: number | null  // null = unlimited
    is_inventoried: boolean
  }
}

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, _user: B2BUser) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }

  const c = sb()

  // Fetch visible items only. Admin-only fields excluded from the projection.
  const { data: rows, error } = await c
    .from('b2b_catalogue')
    .select(`
      id, myob_item_uid, sku, name, description,
      trade_price_ex_gst, rrp_ex_gst, is_taxable,
      primary_image_url, category_id
    `)
    .eq('b2b_visible', true)
    .order('name', { ascending: true })

  if (error) return res.status(500).json({ error: error.message })

  const items = rows || []
  const uids = items.map((i: any) => i.myob_item_uid).filter(Boolean) as string[]

  // Pull stock (refreshes from MYOB if cache is stale)
  let stockMap: Record<string, any> = {}
  let stockError: string | null = null
  try {
    stockMap = await getStockForItems(uids)
  } catch (e: any) {
    // If MYOB is down, we still return the catalogue with stock=unknown.
    // Distributor experience: the page loads but no add-to-cart.
    stockError = e?.message || String(e)
    console.error('Stock fetch failed:', stockError)
  }

  const out: PublicCatalogueItem[] = items.map((it: any) => {
    const s = it.myob_item_uid ? stockMap[it.myob_item_uid] : null
    return {
      id:                 it.id,
      sku:                it.sku,
      name:               it.name,
      description:        it.description,
      trade_price_ex_gst: Number(it.trade_price_ex_gst || 0),
      rrp_ex_gst:         it.rrp_ex_gst != null ? Number(it.rrp_ex_gst) : null,
      is_taxable:         it.is_taxable !== false,
      primary_image_url:  it.primary_image_url,
      category_id:        it.category_id,
      stock: {
        state:          stockState(s),
        qty_available:  s ? (s.isInventoried ? s.qtyAvailable : null) : null,
        is_inventoried: s ? s.isInventoried : true,
      },
    }
  })

  return res.status(200).json({
    items: out,
    stock_error: stockError,  // null on success; surface in UI if non-null
    fetched_at: new Date().toISOString(),
  })
})
