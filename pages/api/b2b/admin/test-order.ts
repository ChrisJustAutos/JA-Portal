// pages/api/b2b/admin/test-order.ts
// Admin tool: create a TEST order on behalf of a chosen distributor, priced
// exactly like a real order, then hand back a Stripe test-checkout URL. The
// order is flagged is_test (it otherwise behaves like a real order — the
// pipeline fires on payment, or via the "mark paid" shortcut).
//
// POST { distributorId, items:[{catalogueId, qty}], customerPo? }

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { applyPricing } from '../../../../lib/b2b-pricing'
import { createCheckoutSession, StripeLineItem } from '../../../../lib/stripe'
import { assertCheckoutConfigured } from '../../../../lib/b2b-settings'

const GST_RATE = 0.10
const round2 = (n: number) => Math.round(n * 100) / 100

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export const config = { maxDuration: 30 }

export default withAuth('admin:b2b', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const body = (req.body && typeof req.body === 'object') ? req.body : {}
  const distributorId = String(body.distributorId || '').trim()
  const customerPo = typeof body.customer_po === 'string' || typeof body.customerPo === 'string'
    ? String(body.customer_po ?? body.customerPo).trim().slice(0, 20) || null : null
  const items: Array<{ catalogueId: string; qty: number }> = Array.isArray(body.items)
    ? body.items.map((i: any) => ({ catalogueId: String(i.catalogueId || ''), qty: Math.max(1, Math.floor(Number(i.qty) || 0)) })).filter((i: any) => i.catalogueId && i.qty > 0)
    : []
  if (!distributorId) return res.status(400).json({ error: 'distributorId required' })
  if (items.length === 0) return res.status(400).json({ error: 'At least one item required' })

  let cfg: any
  try { cfg = await assertCheckoutConfigured() }
  catch (e: any) { return res.status(503).json({ error: 'Checkout not configured — fix B2B Settings first.', detail: e?.message }) }

  const c = sb()
  const { data: dist } = await c.from('b2b_distributors').select('id, display_name, primary_contact_email').eq('id', distributorId).maybeSingle()
  if (!dist) return res.status(404).json({ error: 'Distributor not found' })

  const ids = items.map(i => i.catalogueId)
  const { data: catRows, error: catErr } = await c.from('b2b_catalogue')
    .select('id, myob_item_uid, sku, name, trade_price_ex_gst, is_taxable, promo_price_ex_gst, promo_starts_at, promo_ends_at, volume_breaks')
    .in('id', ids)
  if (catErr) return res.status(500).json({ error: catErr.message })
  const catById = new Map((catRows || []).map((r: any) => [r.id, r]))

  // Price + build validated lines (mirrors checkout/start.ts).
  const now = new Date()
  const validated = items.map(it => {
    const cat: any = catById.get(it.catalogueId)
    if (!cat) throw new Error(`Catalogue item ${it.catalogueId} not found`)
    const priced = applyPricing(cat, it.qty, now)
    return {
      catalogueId: cat.id, myobItemUid: cat.myob_item_uid, sku: cat.sku, name: cat.name,
      qty: it.qty, unitPriceEx: round2(priced.unit_price_ex_gst), isTaxable: cat.is_taxable !== false,
    }
  })

  let subtotalEx = 0, gst = 0
  for (const v of validated) {
    const lineEx = round2(v.unitPriceEx * v.qty)
    subtotalEx += lineEx
    if (v.isTaxable) gst += lineEx * GST_RATE
  }
  subtotalEx = round2(subtotalEx); gst = round2(gst)
  const subtotalInc = round2(subtotalEx + gst)
  const charged = subtotalInc > 0 ? (subtotalInc + cfg.cardFeeFixed) / (1 - cfg.cardFeePct) : 0
  const cardFeeInc = round2(Math.max(0, charged - subtotalInc))
  const totalInc = round2(subtotalInc + cardFeeInc)

  const { data: order, error: orderErr } = await c.from('b2b_orders').insert({
    // placed_by_user_id FKs b2b_distributor_users — an admin isn't one, so leave
    // it null (the test_order_created event records the admin actor instead).
    distributor_id: distributorId, placed_by_user_id: null, status: 'pending_payment',
    subtotal_ex_gst: subtotalEx, gst, card_fee_inc: cardFeeInc, total_inc: totalInc,
    currency: 'AUD', myob_company_file: 'JAWS', customer_po: customerPo, is_test: true,
  }).select('id, order_number').single()
  if (orderErr) return res.status(500).json({ error: orderErr.message })

  const orderLineRows = validated.map((v, i) => {
    const lineEx = round2(v.unitPriceEx * v.qty)
    const lineGst = v.isTaxable ? round2(lineEx * GST_RATE) : 0
    return { order_id: order.id, catalogue_id: v.catalogueId, myob_item_uid: v.myobItemUid, sku: v.sku, name: v.name, qty: v.qty, unit_trade_price_ex_gst: v.unitPriceEx, line_subtotal_ex_gst: lineEx, line_gst: lineGst, line_total_inc: round2(lineEx + lineGst), is_taxable: v.isTaxable, sort_order: i }
  })
  const { error: olErr } = await c.from('b2b_order_lines').insert(orderLineRows)
  if (olErr) { await c.from('b2b_orders').delete().eq('id', order.id); return res.status(500).json({ error: `Order lines insert failed: ${olErr.message}` }) }

  // Stripe (test) checkout session.
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://ja-portal.vercel.app'
  const stripeLineItems: StripeLineItem[] = validated.map(v => ({
    price_data: { currency: 'aud', product_data: { name: v.name, description: `SKU: ${v.sku}` }, unit_amount: Math.round((v.isTaxable ? v.unitPriceEx * 1.10 : v.unitPriceEx) * 100) },
    quantity: v.qty,
  }))
  if (cardFeeInc > 0) stripeLineItems.push({ price_data: { currency: 'aud', product_data: { name: 'Card processing surcharge', description: 'Recovers Stripe transaction fees' }, unit_amount: Math.round(cardFeeInc * 100) }, quantity: 1 })

  let checkoutUrl: string | null = null
  try {
    const session = await createCheckoutSession({
      line_items: stripeLineItems,
      success_url: `${baseUrl}/admin/b2b/orders/${order.id}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/admin/b2b/test-order?cancelled=${order.id}`,
      customer_email: user.email,
      metadata: { order_id: order.id, order_number: order.order_number, b2b_user_id: user.id, distributor_id: distributorId, is_test: 'true' },
      payment_intent_data: { description: `[TEST] ${order.order_number} — ${dist.display_name}`, metadata: { order_id: order.id, order_number: order.order_number } },
    })
    checkoutUrl = session.url
    await c.from('b2b_orders').update({ stripe_checkout_session_id: session.id }).eq('id', order.id)
  } catch (e: any) {
    // Order still created — admin can use the "Mark paid" shortcut instead.
    console.error('test-order: Stripe session failed (non-fatal):', e?.message)
  }

  await c.from('b2b_order_events').insert({ order_id: order.id, event_type: 'test_order_created', to_status: 'pending_payment', actor_type: 'system', actor_id: user.id, notes: `Test order by ${user.email}`, metadata: { total_inc: totalInc, customer_po: customerPo } })

  return res.status(200).json({ orderId: order.id, orderNumber: order.order_number, checkoutUrl, total_inc: totalInc })
})
