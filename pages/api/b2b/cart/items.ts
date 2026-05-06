// pages/api/b2b/cart/items.ts
//
// POST /api/b2b/cart/items
//   body: { catalogue_id, qty }
//
// "Set this catalogue item to this qty in my cart."
//   - qty <= 0 → removes the line (or no-op if not present)
//   - first add: inserts new line
//   - subsequent: updates qty + refreshes trade_price_ex_gst_at_add
//
// Returns just { ok, line } so the client can patch local state without
// re-fetching the entire cart. The cart page is welcome to GET /api/b2b/cart
// after a mutation if it wants the recomputed totals.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../../lib/b2bAuthServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user: B2BUser) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {}
  const catalogueId = String(body.catalogue_id || '').trim()
  const qty = Math.max(0, Math.floor(Number(body.qty || 0)))

  if (!catalogueId) return res.status(400).json({ error: 'catalogue_id required' })
  if (!isFinite(qty)) return res.status(400).json({ error: 'qty must be a non-negative integer' })

  const c = sb()

  // Verify the catalogue item exists and is visible
  const { data: cat, error: catErr } = await c
    .from('b2b_catalogue')
    .select('id, sku, name, trade_price_ex_gst, b2b_visible')
    .eq('id', catalogueId)
    .maybeSingle()
  if (catErr) return res.status(500).json({ error: catErr.message })
  if (!cat) return res.status(404).json({ error: 'Catalogue item not found' })
  if (cat.b2b_visible === false) return res.status(403).json({ error: 'Item is not available' })

  // Get-or-create cart
  let cartId: string
  {
    const { data: existing } = await c
      .from('b2b_carts')
      .select('id')
      .eq('distributor_user_id', user.id)
      .maybeSingle()
    if (existing) {
      cartId = existing.id
    } else {
      const { data: created, error: insertErr } = await c
        .from('b2b_carts')
        .insert({ distributor_user_id: user.id, distributor_id: user.distributor.id })
        .select('id')
        .single()
      if (insertErr) return res.status(500).json({ error: insertErr.message })
      cartId = created.id
    }
  }

  // Look up an existing line for this item
  const { data: existingLine } = await c
    .from('b2b_cart_items')
    .select('id')
    .eq('cart_id', cartId)
    .eq('catalogue_id', catalogueId)
    .maybeSingle()

  if (qty === 0) {
    if (existingLine) {
      await c.from('b2b_cart_items').delete().eq('id', existingLine.id)
    }
    return res.status(200).json({ ok: true, removed: true })
  }

  if (existingLine) {
    const { data: updated, error: updErr } = await c
      .from('b2b_cart_items')
      .update({
        qty,
        trade_price_ex_gst_at_add: Number(cat.trade_price_ex_gst || 0),
        updated_at: new Date().toISOString(),
      })
      .eq('id', existingLine.id)
      .select()
      .single()
    if (updErr) return res.status(500).json({ error: updErr.message })
    return res.status(200).json({ ok: true, line: updated })
  } else {
    const { data: inserted, error: insErr } = await c
      .from('b2b_cart_items')
      .insert({
        cart_id: cartId,
        catalogue_id: catalogueId,
        qty,
        trade_price_ex_gst_at_add: Number(cat.trade_price_ex_gst || 0),
      })
      .select()
      .single()
    if (insErr) return res.status(500).json({ error: insErr.message })
    return res.status(201).json({ ok: true, line: inserted })
  }
})
