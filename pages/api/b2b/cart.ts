// pages/api/b2b/cart.ts
//
// GET /api/b2b/cart  — returns the signed-in distributor user's cart with
// expanded line items (joined to b2b_catalogue for display) and computed totals.
//
// Cart is per-distributor-user (carts.distributor_user_id is unique).
// Auto-creates an empty cart on first GET so the UI always has a row to write to.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../lib/b2bAuthServer'
import { getStockForItems, stockState } from '../../../lib/b2b-stock'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const CARD_FEE_PCT   = 0.017  // 1.7%
const CARD_FEE_FIXED = 0.30   // 30c

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user: B2BUser) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }

  const c = sb()

  // Get-or-create cart for this user
  const cart = await getOrCreateCart(c, user)

  // Pull line items joined to catalogue for display
  const { data: items, error: itemsErr } = await c
    .from('b2b_cart_items')
    .select(`
      id, qty, trade_price_ex_gst_at_add, added_at, updated_at,
      catalogue:b2b_catalogue!b2b_cart_items_catalogue_id_fkey (
        id, myob_item_uid, sku, name, primary_image_url,
        trade_price_ex_gst, is_taxable, b2b_visible
      )
    `)
    .eq('cart_id', cart.id)
    .order('added_at', { ascending: true })

  if (itemsErr) return res.status(500).json({ error: itemsErr.message })

  // Pull live stock for everything in the cart
  const uids = (items || [])
    .map((i: any) => Array.isArray(i.catalogue) ? i.catalogue[0]?.myob_item_uid : i.catalogue?.myob_item_uid)
    .filter(Boolean) as string[]
  let stockMap: Record<string, any> = {}
  try {
    stockMap = await getStockForItems(uids)
  } catch (e) {
    console.error('Cart stock fetch failed:', e)
  }

  const lines = (items || []).map((it: any) => {
    const cat = Array.isArray(it.catalogue) ? it.catalogue[0] : it.catalogue
    const stock = cat?.myob_item_uid ? stockMap[cat.myob_item_uid] : null
    const unitPriceEx = Number(cat?.trade_price_ex_gst ?? it.trade_price_ex_gst_at_add ?? 0)
    const lineSubEx = unitPriceEx * it.qty
    const lineGst = (cat?.is_taxable !== false) ? lineSubEx * 0.10 : 0
    return {
      id: it.id,
      qty: it.qty,
      catalogue_id: cat?.id ?? null,
      sku: cat?.sku ?? '',
      name: cat?.name ?? '(item removed)',
      image_url: cat?.primary_image_url ?? null,
      unit_price_ex_gst: unitPriceEx,
      is_taxable: cat?.is_taxable !== false,
      line_subtotal_ex_gst: lineSubEx,
      line_gst: lineGst,
      line_total_inc_gst: lineSubEx + lineGst,
      // Distributor-relevant warnings
      currently_visible: cat?.b2b_visible !== false,
      price_changed: cat ? Math.abs(Number(cat.trade_price_ex_gst) - Number(it.trade_price_ex_gst_at_add)) > 0.005 : false,
      stock_state: stockState(stock),
      stock_qty_available: stock ? (stock.isInventoried ? stock.qtyAvailable : null) : null,
    }
  })

  // Totals
  const subtotal_ex_gst = lines.reduce((s: number, l: any) => s + l.line_subtotal_ex_gst, 0)
  const gst             = lines.reduce((s: number, l: any) => s + l.line_gst, 0)
  const subtotal_inc_gst = subtotal_ex_gst + gst

  // Card fee — distributor pays a gross-up so Stripe takes its cut and the
  // payout to JAWS = subtotal_inc_gst.
  //   charged   = (subtotal_inc + 0.30) / (1 - 0.017)
  //   card_fee  = charged - subtotal_inc
  const charged = subtotal_inc_gst > 0
    ? (subtotal_inc_gst + CARD_FEE_FIXED) / (1 - CARD_FEE_PCT)
    : 0
  const card_fee_inc = Math.max(0, charged - subtotal_inc_gst)
  const total_inc = subtotal_inc_gst + card_fee_inc

  return res.status(200).json({
    cart_id: cart.id,
    distributor: {
      id: user.distributor.id,
      display_name: user.distributor.displayName,
    },
    lines,
    line_count: lines.length,
    item_count: lines.reduce((s: number, l: any) => s + l.qty, 0),
    totals: {
      subtotal_ex_gst:  round2(subtotal_ex_gst),
      gst:              round2(gst),
      subtotal_inc_gst: round2(subtotal_inc_gst),
      card_fee_inc:     round2(card_fee_inc),
      total_inc:        round2(total_inc),
    },
    card_fee: {
      pct: CARD_FEE_PCT,
      fixed: CARD_FEE_FIXED,
      note: `Estimated Stripe surcharge (${(CARD_FEE_PCT * 100).toFixed(1)}% + $${CARD_FEE_FIXED.toFixed(2)}). Final amount confirmed at checkout.`,
    },
  })
})

async function getOrCreateCart(c: SupabaseClient, user: B2BUser): Promise<{ id: string }> {
  const { data: existing, error: lookupErr } = await c
    .from('b2b_carts')
    .select('id')
    .eq('distributor_user_id', user.id)
    .maybeSingle()
  if (lookupErr) throw new Error(`Cart lookup failed: ${lookupErr.message}`)
  if (existing) return { id: existing.id }

  const { data: created, error: insertErr } = await c
    .from('b2b_carts')
    .insert({
      distributor_user_id: user.id,
      distributor_id: user.distributor.id,
    })
    .select('id')
    .single()
  if (insertErr) throw new Error(`Cart create failed: ${insertErr.message}`)
  return { id: created.id }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
