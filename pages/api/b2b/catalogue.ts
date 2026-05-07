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
import { getStockForItems, stockState, StockState, getCommittedQtyByCatalogue, availableQty } from '../../../lib/b2b-stock'
import { applyPricing } from '../../../lib/b2b-pricing'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

interface TaxonomyRef {
  id: string
  name: string
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
  model: TaxonomyRef | null
  product_type: TaxonomyRef | null
  // Effective unit price at qty=1, after promo + volume-break rules
  unit_price_ex_gst: number
  promo_active: boolean
  has_volume_breaks: boolean
  volume_breaks: { min_qty: number; unit_price_ex_gst: number }[]
  // Distributor-facing badges + extras
  is_special_order: boolean
  is_drop_ship: boolean
  instructions_url: string | null
  max_order_qty: number | null
  stock: {
    state: StockState
    qty_available: number | null  // null = unlimited
    is_inventoried: boolean
    /** True when this item should display "Call for availability" instead
     *  of the normal stock label (per-item rule). */
    call_for_availability: boolean
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
      primary_image_url,
      promo_price_ex_gst, promo_starts_at, promo_ends_at, volume_breaks,
      is_special_order, is_drop_ship, instructions_url, max_order_qty,
      call_for_availability_below_qty, call_for_availability_when_zero,
      model:b2b_models!b2b_catalogue_model_id_fkey ( id, name ),
      product_type:b2b_product_types!b2b_catalogue_product_type_id_fkey ( id, name )
    `)
    .eq('b2b_visible', true)
    .order('name', { ascending: true })

  if (error) return res.status(500).json({ error: error.message })

  const items = rows || []
  const uids = items.map((i: any) => i.myob_item_uid).filter(Boolean) as string[]
  const catalogueIds = items.map((i: any) => i.id) as string[]

  // Pull stock + in-flight commitments in parallel
  let stockMap: Record<string, any> = {}
  let committed: Record<string, number> = {}
  let stockError: string | null = null
  try {
    [stockMap, committed] = await Promise.all([
      getStockForItems(uids),
      getCommittedQtyByCatalogue(catalogueIds),
    ])
  } catch (e: any) {
    stockError = e?.message || String(e)
    console.error('Stock fetch failed:', stockError)
  }

  const pickRef = (raw: any): TaxonomyRef | null => {
    const r = Array.isArray(raw) ? raw[0] : raw
    return r && r.id ? { id: r.id, name: r.name } : null
  }

  const now = new Date()

  const out: PublicCatalogueItem[] = items.map((it: any) => {
    const s = it.myob_item_uid ? stockMap[it.myob_item_uid] : null
    const avail = availableQty(s, committed[it.id] || 0)
    const tradePrice = Number(it.trade_price_ex_gst || 0)
    const breaks = Array.isArray(it.volume_breaks) ? it.volume_breaks as { min_qty: number; unit_price_ex_gst: number }[] : []
    // Display the price the distributor sees AT QTY 1 — volume breaks
    // kick in dynamically in the cart.
    const px = applyPricing({
      trade_price_ex_gst: tradePrice,
      promo_price_ex_gst: it.promo_price_ex_gst != null ? Number(it.promo_price_ex_gst) : null,
      promo_starts_at:    it.promo_starts_at,
      promo_ends_at:      it.promo_ends_at,
      volume_breaks:      breaks,
    }, 1, now)

    // Per-item "Call for availability" rules
    const inv = s ? s.isInventoried : true
    const qtyAvail = avail   // null for non-inventoried
    let callForAvail = false
    if (inv) {
      if (it.call_for_availability_when_zero && (qtyAvail ?? 0) <= 0) callForAvail = true
      const threshold = it.call_for_availability_below_qty
      if (threshold != null && qtyAvail != null && qtyAvail <= threshold) callForAvail = true
    }

    return {
      id:                 it.id,
      sku:                it.sku,
      name:               it.name,
      description:        it.description,
      trade_price_ex_gst: tradePrice,
      rrp_ex_gst:         it.rrp_ex_gst != null ? Number(it.rrp_ex_gst) : null,
      is_taxable:         it.is_taxable !== false,
      primary_image_url:  it.primary_image_url,
      model:              pickRef(it.model),
      product_type:       pickRef(it.product_type),
      unit_price_ex_gst:  px.unit_price_ex_gst,
      promo_active:       px.promo_active,
      has_volume_breaks:  breaks.length > 0,
      volume_breaks:      breaks,
      is_special_order:   it.is_special_order === true,
      is_drop_ship:       it.is_drop_ship === true,
      instructions_url:   it.instructions_url || null,
      max_order_qty:      it.max_order_qty != null ? Number(it.max_order_qty) : null,
      stock: {
        state:                  stockState(s),
        qty_available:          qtyAvail,
        is_inventoried:         inv,
        call_for_availability:  callForAvail,
      },
    }
  })

  return res.status(200).json({
    items: out,
    stock_error: stockError,  // null on success; surface in UI if non-null
    fetched_at: new Date().toISOString(),
  })
})
