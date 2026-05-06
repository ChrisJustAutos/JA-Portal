// pages/api/b2b/checkout/start.ts
//
// POST /api/b2b/checkout/start
//   body: { customer_po?: string }
//
// Creates a b2b_orders row in 'pending_payment' status, snapshots cart
// lines into b2b_order_lines, then opens a Stripe Checkout Session.
// Returns the Stripe URL the client should redirect the browser to.
//
// Stale-cart protection: validates each line at checkout time:
//   - item still b2b_visible
//   - trade_price_ex_gst > 0
//   - if inventoried: qty <= qty_available (using cached stock)

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../../lib/b2bAuthServer'
import { getStockForItems, stockState } from '../../../../lib/b2b-stock'
import { createCheckoutSession, StripeLineItem } from '../../../../lib/stripe'
import { assertCheckoutConfigured } from '../../../../lib/b2b-settings'

const GST_RATE = 0.10

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user: B2BUser) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  // Parse PO from request body. Optional, max 20 chars (MYOB limit).
  let customerPo: string | null = null
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    if (typeof body.customer_po === 'string') {
      customerPo = body.customer_po.trim().substring(0, 20) || null
    }
  } catch {
    // Bad JSON in body — ignore, treat as no PO
  }

  // Verify Stripe + MYOB are configured before we charge anyone.
  let cfg
  try {
    cfg = await assertCheckoutConfigured()
  } catch (e: any) {
    return res.status(503).json({
      error: 'Checkout temporarily unavailable. Please contact your account manager.',
      detail: e?.message,
    })
  }

  const c = sb()

  // 1. Load cart with lines + catalogue snapshots
  const { data: cart } = await c
    .from('b2b_carts')
    .select('id')
    .eq('distributor_user_id', user.id)
    .maybeSingle()
  if (!cart) return res.status(400).json({ error: 'Your cart is empty' })

  const { data: lines, error: linesErr } = await c
    .from('b2b_cart_items')
    .select(`
      id, qty,
      catalogue:b2b_catalogue!b2b_cart_items_catalogue_id_fkey (
        id, myob_item_uid, sku, name,
        trade_price_ex_gst, is_taxable, b2b_visible
      )
    `)
    .eq('cart_id', cart.id)
    .order('added_at', { ascending: true })
  if (linesErr) return res.status(500).json({ error: linesErr.message })
  if (!lines || lines.length === 0) return res.status(400).json({ error: 'Your cart is empty' })

  // 2. Validate each line + pull current stock
  type RawLine = {
    cartItemId: string
    catalogueId: string
    myobItemUid: string | null
    sku: string
    name: string
    qty: number
    unitPriceEx: number
    isTaxable: boolean
  }
  const validated: RawLine[] = []
  const issues: string[] = []

  for (const ln of lines) {
    const cat: any = Array.isArray(ln.catalogue) ? ln.catalogue[0] : ln.catalogue
    if (!cat) {
      issues.push(`A cart item references a removed catalogue entry — please refresh your cart`)
      continue
    }
    if (!cat.b2b_visible) {
      issues.push(`"${cat.name}" is no longer available — please remove it from your cart`)
      continue
    }
    const unitPrice = Number(cat.trade_price_ex_gst || 0)
    if (unitPrice <= 0) {
      issues.push(`"${cat.name}" has no price set — please remove it from your cart`)
      continue
    }
    if (!cat.myob_item_uid) {
      issues.push(`"${cat.name}" is missing a MYOB link — please contact your account manager`)
      continue
    }
    if (ln.qty <= 0) continue
    validated.push({
      cartItemId:   ln.id,
      catalogueId:  cat.id,
      myobItemUid:  cat.myob_item_uid,
      sku:          cat.sku,
      name:         cat.name,
      qty:          ln.qty,
      unitPriceEx:  unitPrice,
      isTaxable:    cat.is_taxable !== false,
    })
  }

  if (validated.length === 0) {
    return res.status(400).json({
      error: 'No valid items in your cart',
      details: issues,
    })
  }

  // Stock check (cached + auto-refresh)
  let stockMap: Record<string, any> = {}
  try {
    stockMap = await getStockForItems(validated.map(v => v.myobItemUid!).filter(Boolean) as string[])
  } catch (e) {
    return res.status(503).json({
      error: 'Live stock check failed — please try again in a moment',
    })
  }
  for (const v of validated) {
    const s = stockMap[v.myobItemUid!]
    if (s && s.isInventoried && v.qty > s.qtyAvailable) {
      issues.push(`"${v.name}" — only ${s.qtyAvailable} available, you have ${v.qty} in your cart`)
    } else if (s && stockState(s) === 'out_of_stock') {
      issues.push(`"${v.name}" is out of stock — please remove it`)
    }
  }
  if (issues.length > 0) {
    return res.status(409).json({
      error: 'Some items in your cart need attention',
      details: issues,
    })
  }

  // 3. Compute totals
  let subtotalEx = 0
  let gst = 0
  for (const v of validated) {
    const lineEx = v.unitPriceEx * v.qty
    subtotalEx += lineEx
    if (v.isTaxable) gst += lineEx * GST_RATE
  }
  subtotalEx = round2(subtotalEx)
  gst = round2(gst)
  const subtotalInc = round2(subtotalEx + gst)
  const charged = subtotalInc > 0
    ? (subtotalInc + cfg.cardFeeFixed) / (1 - cfg.cardFeePct)
    : 0
  const cardFeeInc = round2(Math.max(0, charged - subtotalInc))
  const totalInc   = round2(subtotalInc + cardFeeInc)

  // 4. Insert order header (status pending_payment, no Stripe ID yet)
  const { data: order, error: orderErr } = await c
    .from('b2b_orders')
    .insert({
      distributor_id: user.distributor.id,
      placed_by_user_id: user.id,
      status: 'pending_payment',
      subtotal_ex_gst: subtotalEx,
      gst: gst,
      card_fee_inc: cardFeeInc,
      total_inc: totalInc,
      currency: 'AUD',
      myob_company_file: 'JAWS',
      customer_po: customerPo,
    })
    .select('id, order_number')
    .single()
  if (orderErr) return res.status(500).json({ error: orderErr.message })

  // 5. Insert order lines (snapshots — won't change if catalogue updates)
  const orderLineRows = validated.map((v, i) => {
    const lineEx = round2(v.unitPriceEx * v.qty)
    const lineGst = v.isTaxable ? round2(lineEx * GST_RATE) : 0
    return {
      order_id: order.id,
      catalogue_id: v.catalogueId,
      myob_item_uid: v.myobItemUid,
      sku: v.sku,
      name: v.name,
      qty: v.qty,
      unit_trade_price_ex_gst: v.unitPriceEx,
      line_subtotal_ex_gst: lineEx,
      line_gst: lineGst,
      line_total_inc: round2(lineEx + lineGst),
      is_taxable: v.isTaxable,
      sort_order: i,
    }
  })
  const { error: olErr } = await c.from('b2b_order_lines').insert(orderLineRows)
  if (olErr) {
    await c.from('b2b_orders').delete().eq('id', order.id)
    return res.status(500).json({ error: `Order lines insert failed: ${olErr.message}` })
  }

  // 6. Build Stripe line_items (one per cart line + surcharge)
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://ja-portal.vercel.app'
  const stripeLineItems: StripeLineItem[] = validated.map(v => {
    const unitInc = v.isTaxable ? v.unitPriceEx * 1.10 : v.unitPriceEx
    return {
      price_data: {
        currency: 'aud',
        product_data: {
          name: v.name,
          description: `SKU: ${v.sku}`,
        },
        unit_amount: Math.round(unitInc * 100),
      },
      quantity: v.qty,
    }
  })

  if (cardFeeInc > 0) {
    stripeLineItems.push({
      price_data: {
        currency: 'aud',
        product_data: {
          name: 'Card processing surcharge',
          description: 'Recovers Stripe transaction fees',
        },
        unit_amount: Math.round(cardFeeInc * 100),
      },
      quantity: 1,
    })
  }

  // 7. Create Stripe Checkout Session
  let session
  try {
    session = await createCheckoutSession({
      line_items: stripeLineItems,
      success_url: `${baseUrl}/b2b/orders/${order.id}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}/b2b/cart?cancelled=${order.id}`,
      customer_email: user.email,
      metadata: {
        order_id: order.id,
        order_number: order.order_number,
        b2b_user_id: user.id,
        distributor_id: user.distributor.id,
      },
      payment_intent_data: {
        description: `${order.order_number} — ${user.distributor.displayName}${customerPo ? ` — PO ${customerPo}` : ''}`,
        metadata: {
          order_id: order.id,
          order_number: order.order_number,
          customer_po: customerPo || '',
        },
      },
    })
  } catch (e: any) {
    await c.from('b2b_order_lines').delete().eq('order_id', order.id)
    await c.from('b2b_orders').delete().eq('id', order.id)
    return res.status(502).json({ error: `Stripe checkout failed: ${e?.message || String(e)}` })
  }

  // 8. Save Stripe session id and emit a status event
  await c.from('b2b_orders')
    .update({ stripe_checkout_session_id: session.id })
    .eq('id', order.id)
  await c.from('b2b_order_events').insert({
    order_id: order.id,
    event_type: 'checkout_started',
    to_status: 'pending_payment',
    actor_type: 'distributor_user',
    actor_id: null,
    notes: `Stripe session ${session.id} created${customerPo ? ` (PO: ${customerPo})` : ''}`,
    metadata: { stripe_session_id: session.id, total_inc: totalInc, customer_po: customerPo },
  })

  return res.status(200).json({
    order_id: order.id,
    order_number: order.order_number,
    checkout_url: session.url,
    stripe_session_id: session.id,
    customer_po: customerPo,
    totals: {
      subtotal_ex_gst: subtotalEx,
      gst: gst,
      subtotal_inc_gst: subtotalInc,
      card_fee_inc: cardFeeInc,
      total_inc: totalInc,
    },
  })
})
