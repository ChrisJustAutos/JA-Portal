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
import { paytoSurchargeInc } from '../../../../lib/b2b-payment'
import { assertCheckoutConfigured } from '../../../../lib/b2b-settings'
import { getLiveQuote, getSatchelRates, getDropshipFreight, type LiveQuoteCartItem } from '../../../../lib/b2b-freight'

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
  const paymentMethod: 'card' | 'becs' | 'payto' = (body.payment_method === 'becs' || body.payment_method === 'payto') ? body.payment_method : 'card'
  const items: Array<{ catalogueId: string; qty: number }> = Array.isArray(body.items)
    ? body.items.map((i: any) => ({ catalogueId: String(i.catalogueId || ''), qty: Math.max(1, Math.floor(Number(i.qty) || 0)) })).filter((i: any) => i.catalogueId && i.qty > 0)
    : []
  if (!distributorId) return res.status(400).json({ error: 'distributorId required' })
  if (items.length === 0) return res.status(400).json({ error: 'At least one item required' })

  // Optional freight selection (mirrors checkout/start.ts). Either a static
  // zone rate id OR a live MachShip route — mutually exclusive. The chosen
  // rate is re-quoted server-side below so the order carries a real, bookable
  // freight selection (Mark paid → Book Freight uses it end-to-end).
  let chosenFreightRateId: string | null = typeof body.freightRateId === 'string' && body.freightRateId.trim() ? body.freightRateId.trim() : null
  let chosenSatchelId: string | null = typeof body.freightSatchelId === 'string' && body.freightSatchelId.trim() ? body.freightSatchelId.trim().replace(/^satchel:/, '') : null
  let chosenMachShipRoute: { carrierId: number; carrierServiceId: number; companyCarrierAccountId?: number } | null = null
  const fr = body.freightMachShipRoute
  if (fr && typeof fr === 'object' && Number.isFinite(Number(fr.carrierId)) && Number.isFinite(Number(fr.carrierServiceId))) {
    chosenMachShipRoute = {
      carrierId: Number(fr.carrierId), carrierServiceId: Number(fr.carrierServiceId),
      companyCarrierAccountId: Number.isFinite(Number(fr.companyCarrierAccountId)) ? Number(fr.companyCarrierAccountId) : undefined,
    }
  }
  if ([chosenFreightRateId, chosenSatchelId, chosenMachShipRoute].filter(Boolean).length > 1) return res.status(400).json({ error: 'Pick a single freight option (rate, satchel, or carrier route).' })
  const pmRaw = String(body.packMode || '').trim()
  const packMode = (pmRaw === 'pallet' || pmRaw === 'cartons' || pmRaw === 'auto') ? pmRaw as ('pallet' | 'cartons' | 'auto') : undefined
  const shipPostcodeIn = String(body.shipPostcode || '').trim()
  const shipSuburbIn   = String(body.shipSuburb || '').trim()

  let cfg: any
  try { cfg = await assertCheckoutConfigured() }
  catch (e: any) { return res.status(503).json({ error: 'Checkout not configured — fix B2B Settings first.', detail: e?.message }) }

  const c = sb()
  const { data: dist } = await c.from('b2b_distributors').select('id, display_name, primary_contact_email, ship_suburb, ship_postcode, bill_suburb, bill_postcode').eq('id', distributorId).maybeSingle()
  if (!dist) return res.status(404).json({ error: 'Distributor not found' })

  const ids = items.map(i => i.catalogueId)
  const { data: catRows, error: catErr } = await c.from('b2b_catalogue')
    .select('id, myob_item_uid, sku, name, trade_price_ex_gst, is_taxable, is_drop_ship, promo_price_ex_gst, promo_starts_at, promo_ends_at, volume_breaks, freight_weight_g, freight_length_mm, freight_width_mm, freight_height_mm, freight_packaging, manual_handling, inbound_freight_cost_ex_gst')
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
  // ── Resolve freight (optional) — re-quote server-side, fold into totals ──
  let freightExGst = 0
  let freightLabel: string | null = null
  let freightZoneId: string | null = null
  let freightMachShipCarrierId: number | null = null
  let freightMachShipServiceId: number | null = null
  let freightChosenQuoteSnapshot: any = null
  let freightQuoteMarkupPct: number | null = null
  let freightSatchelId: string | null = null

  if (chosenFreightRateId) {
    const { data: rate, error: rErr } = await c
      .from('b2b_freight_rates')
      .select('id, label, price_ex_gst, is_active, zone_id, b2b_freight_zones!inner(id, name, is_active)')
      .eq('id', chosenFreightRateId)
      .maybeSingle()
    if (rErr) return res.status(500).json({ error: rErr.message })
    if (!rate || !rate.is_active) return res.status(400).json({ error: 'Selected freight rate is not available — re-quote and pick again.' })
    const zone: any = Array.isArray(rate.b2b_freight_zones) ? rate.b2b_freight_zones[0] : rate.b2b_freight_zones
    if (!zone || !zone.is_active) return res.status(400).json({ error: 'Freight zone for the selected rate is no longer active.' })
    freightExGst = round2(Number(rate.price_ex_gst) || 0)
    freightLabel = `${zone.name} — ${rate.label}`
    freightZoneId = zone.id
  } else if (chosenSatchelId) {
    const eligItems = validated
      .filter(v => (catById.get(v.catalogueId) as any)?.is_drop_ship !== true)
      .map(v => {
        const cat: any = catById.get(v.catalogueId) || {}
        return {
          qty: v.qty,
          weight_g: cat.freight_weight_g ?? null,
          length_mm: cat.freight_length_mm ?? null,
          width_mm: cat.freight_width_mm ?? null,
          height_mm: cat.freight_height_mm ?? null,
          packaging: cat.freight_packaging ?? null,
        }
      })
    const eligible = await getSatchelRates(eligItems)
    const match = eligible.find(e => e.satchel_id === chosenSatchelId)
    if (!match) return res.status(400).json({ error: 'This order does not fit the selected satchel (too heavy / too big / pallet / missing weight).' })
    freightExGst = round2(match.price_ex_gst)
    freightLabel = match.label
    freightSatchelId = match.satchel_id
    freightChosenQuoteSnapshot = {
      type: 'satchel', satchel_id: match.satchel_id, name: match.label,
      sell_ex_gst: round2(match.price_ex_gst), cost_ex_gst: round2(match.cost_ex_gst),
    }
  } else if (chosenMachShipRoute) {
    const postcode = shipPostcodeIn || String((dist as any).ship_postcode || (dist as any).bill_postcode || '').trim()
    const suburb   = shipSuburbIn   || String((dist as any).ship_suburb   || (dist as any).bill_suburb   || '').trim()
    if (!postcode) return res.status(400).json({ error: 'Live freight needs a destination — give the distributor a ship address or pass a postcode/suburb.' })
    const liveItems: LiveQuoteCartItem[] = validated
      .filter(v => (catById.get(v.catalogueId) as any)?.is_drop_ship !== true)
      .map(v => {
        const cat: any = catById.get(v.catalogueId) || {}
        return {
          sku: v.sku, name: v.name, qty: v.qty,
          freight_weight_g:  cat.freight_weight_g ?? null,
          freight_length_mm: cat.freight_length_mm ?? null,
          freight_width_mm:  cat.freight_width_mm ?? null,
          freight_height_mm: cat.freight_height_mm ?? null,
          freight_packaging: cat.freight_packaging ?? null,
          manual_handling:             cat.manual_handling === true,
          inbound_freight_cost_ex_gst: cat.inbound_freight_cost_ex_gst ?? null,
        }
      })
    const liveQuote = await getLiveQuote(liveItems, { postcode, suburb }, { packMode })
    if (liveQuote.mode === 'blocked') return res.status(400).json({ error: 'Freight quote unavailable — some products are missing dimensions.', details: liveQuote.missing.map(m => `${m.sku} ${m.name} (needs ${m.missing_fields.join(', ')})`) })
    if (liveQuote.mode !== 'live') return res.status(503).json({ error: 'Live freight quoting unavailable — re-quote, pick a static rate, or leave freight off.' })
    const match = liveQuote.rates.find(r => r.machship.carrierId === chosenMachShipRoute!.carrierId && r.machship.carrierServiceId === chosenMachShipRoute!.carrierServiceId)
    if (!match) return res.status(400).json({ error: 'The freight option you chose is no longer offered — re-quote and pick again.' })
    freightExGst = round2(match.price_ex_gst)
    freightLabel = match.label
    freightMachShipCarrierId = match.machship.carrierId
    freightMachShipServiceId = match.machship.carrierServiceId
    freightQuoteMarkupPct = match.markup_pct
    freightChosenQuoteSnapshot = {
      carrierId: match.machship.carrierId, carrierServiceId: match.machship.carrierServiceId,
      companyCarrierAccountId: match.machship.companyCarrierAccountId ?? null,
      label: match.label, price_ex_gst: match.price_ex_gst, base_price_ex_gst: match.base_price_ex_gst,
      markup_pct: match.markup_pct, eta_utc: match.eta_utc, transit_days: match.transit_days,
      route_snapshot: match.machship.routeSnapshot,
    }
  }
  if (freightExGst > 0) { subtotalEx += freightExGst; gst += freightExGst * GST_RATE }

  // Drop-ship freight (supplier-shipped lines, priced by destination zone).
  let dropshipFreightExGst = 0
  const dsLines = validated.filter(v => (catById.get(v.catalogueId) as any)?.is_drop_ship === true)
  if (dsLines.length > 0) {
    const dsPostcode = shipPostcodeIn || String((dist as any).ship_postcode || (dist as any).bill_postcode || '').trim()
    const ds = await getDropshipFreight(dsLines.map(v => ({ catalogue_id: v.catalogueId, sku: v.sku, name: v.name, qty: v.qty, is_drop_ship: true })), dsPostcode)
    if (ds.missing.length > 0) return res.status(400).json({ error: 'Drop-ship freight not set for some items to this destination.', details: ds.missing.map(m => `${m.sku} ${m.name} (${m.reason})`) })
    dropshipFreightExGst = ds.total_ex_gst
    if (dropshipFreightExGst > 0) { subtotalEx += dropshipFreightExGst; gst += dropshipFreightExGst * GST_RATE }
  }
  const hasFreight = !!(chosenFreightRateId || chosenSatchelId || chosenMachShipRoute) || dropshipFreightExGst > 0
  const totalFreightExGst = round2(freightExGst + dropshipFreightExGst)
  if (!freightLabel && dropshipFreightExGst > 0) freightLabel = 'Drop-ship freight'

  subtotalEx = round2(subtotalEx); gst = round2(gst)
  const subtotalInc = round2(subtotalEx + gst)
  let cardFeeInc = 0
  if (paymentMethod === 'card' && subtotalInc > 0) cardFeeInc = round2(Math.max(0, (subtotalInc + cfg.cardFeeFixed) / (1 - cfg.cardFeePct) - subtotalInc))
  else if (paymentMethod === 'payto') cardFeeInc = paytoSurchargeInc(subtotalInc)
  const totalInc = round2(subtotalInc + cardFeeInc)

  const { data: order, error: orderErr } = await c.from('b2b_orders').insert({
    // placed_by_user_id FKs b2b_distributor_users — an admin isn't one, so leave
    // it null (the test_order_created event records the admin actor instead).
    distributor_id: distributorId, placed_by_user_id: null, status: 'pending_payment',
    payment_method: paymentMethod,
    subtotal_ex_gst: subtotalEx, gst, card_fee_inc: cardFeeInc, total_inc: totalInc,
    currency: 'AUD', myob_company_file: 'JAWS', customer_po: customerPo, is_test: true,
    freight_rate_id:             chosenFreightRateId,
    freight_satchel_id:          freightSatchelId,
    freight_zone_id:             freightZoneId,
    dropship_freight_ex_gst:     dropshipFreightExGst > 0 ? dropshipFreightExGst : null,
    freight_method_label:        freightLabel,
    freight_cost_ex_gst:         hasFreight ? totalFreightExGst : null,
    freight_chosen_quote:        freightChosenQuoteSnapshot,
    freight_quote_markup_pct:    freightQuoteMarkupPct,
    machship_carrier_id:         freightMachShipCarrierId,
    machship_carrier_service_id: freightMachShipServiceId,
    freight_service_label:       chosenMachShipRoute ? freightLabel : null,
    freight_pack_mode:           hasFreight ? (packMode || null) : null,
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
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://justautos.app'
  const stripeLineItems: StripeLineItem[] = validated.map(v => ({
    price_data: { currency: 'aud', product_data: { name: v.name, description: `SKU: ${v.sku}` }, unit_amount: Math.round((v.isTaxable ? v.unitPriceEx * 1.10 : v.unitPriceEx) * 100) },
    quantity: v.qty,
  }))
  if (hasFreight && totalFreightExGst > 0) stripeLineItems.push({ price_data: { currency: 'aud', product_data: { name: 'Freight', description: freightLabel || 'Shipping' }, unit_amount: Math.round(round2(totalFreightExGst * 1.10) * 100) }, quantity: 1 })
  if (cardFeeInc > 0) stripeLineItems.push({ price_data: { currency: 'aud', product_data: { name: paymentMethod === 'payto' ? 'PayTo processing fee' : 'Card processing surcharge', description: 'Recovers Stripe transaction fees' }, unit_amount: Math.round(cardFeeInc * 100) }, quantity: 1 })

  let checkoutUrl: string | null = null
  try {
    const pmTypes = paymentMethod === 'becs' ? ['au_becs_debit'] : paymentMethod === 'payto' ? ['payto'] : ['card']
    const session = await createCheckoutSession({
      line_items: stripeLineItems,
      payment_method_types: pmTypes,
      customer_creation: paymentMethod === 'card' ? undefined : 'always',
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

  return res.status(200).json({ orderId: order.id, orderNumber: order.order_number, checkoutUrl, total_inc: totalInc, freight: hasFreight ? { label: freightLabel, cost_ex_gst: freightExGst } : null })
})
