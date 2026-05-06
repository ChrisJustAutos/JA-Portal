// lib/b2b-myob-invoice.ts
//
// Writes a paid B2B order to MYOB JAWS as a Sale.ORDER (not Invoice).
// Sales orders sit in MYOB's Sales > Orders register without GL impact;
// JAWS staff convert them to invoices when goods are picked/shipped.
//
//   POST /accountright/{cf_id}/Sale/Order/Item
//   {
//     Customer: { UID },
//     Date,
//     Number,                          // portal-controlled (b2b_settings)
//     CustomerPurchaseOrderNumber,     // distributor PO if entered at checkout
//     Lines: [
//       { Type:'Transaction', Description, Item:{UID}, ShipQuantity, UnitPrice, Total, TaxCode:{UID} },
//       { Type:'Transaction', Description, Account:{UID}, Total, TaxCode:{UID} },   // surcharge
//     ],
//     IsTaxInclusive: false,
//     FreightAmount: 0,
//     FreightTaxCode: { UID },
//     Subtotal, TotalTax, TotalAmount,
//     JournalMemo, Comment,
//   }
//
// Idempotent: if order.myob_invoice_uid is already set, no-op and return existing.
// (Column names retained as `myob_invoice_*` for backwards compat — they
//  now hold an Order UID/Number rather than an Invoice UID/Number.)

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from './myob'
import { assertCheckoutConfigured } from './b2b-settings'

const UUID_REGEX_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

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

export interface MyobWriteResult {
  myob_invoice_uid: string
  myob_invoice_number: string | null
  status: 'created' | 'already_written'
}

/**
 * Writes the given paid order to MYOB as a Sale.Order. Throws on failure.
 */
export async function writeOrderToMyob(orderId: string): Promise<MyobWriteResult> {
  const c = sb()

  // 1. Load order + lines + distributor (for customer UID)
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select(`
      id, order_number, status,
      subtotal_ex_gst, gst, card_fee_inc, total_inc, currency,
      customer_po,
      myob_invoice_uid, myob_invoice_number,
      myob_write_attempts, paid_at,
      stripe_payment_intent_id,
      distributor:b2b_distributors!b2b_orders_distributor_id_fkey (
        id, display_name, myob_primary_customer_uid
      )
    `)
    .eq('id', orderId)
    .maybeSingle()
  if (oErr) throw new Error(`Order load failed: ${oErr.message}`)
  if (!order) throw new Error(`Order ${orderId} not found`)

  // Idempotency: already written → return existing
  if (order.myob_invoice_uid) {
    return {
      myob_invoice_uid: order.myob_invoice_uid,
      myob_invoice_number: order.myob_invoice_number,
      status: 'already_written',
    }
  }

  if (order.status !== 'paid') {
    throw new Error(`Order ${orderId} is not paid (status=${order.status}); refusing to write to MYOB`)
  }

  const dist: any = Array.isArray(order.distributor) ? order.distributor[0] : order.distributor
  if (!dist?.myob_primary_customer_uid) {
    throw new Error(`Distributor ${dist?.display_name || dist?.id} has no MYOB customer UID`)
  }

  const { data: lines, error: lErr } = await c
    .from('b2b_order_lines')
    .select('id, myob_item_uid, sku, name, qty, unit_trade_price_ex_gst, line_subtotal_ex_gst, line_gst, line_total_inc, is_taxable, sort_order')
    .eq('order_id', orderId)
    .order('sort_order', { ascending: true })
  if (lErr) throw new Error(`Order lines load failed: ${lErr.message}`)
  if (!lines || lines.length === 0) throw new Error(`Order ${orderId} has no lines`)

  // 2. Resolve config (tax code UIDs, card fee account)
  const cfg = await assertCheckoutConfigured()

  const conn = await getConnection('JAWS')
  if (!conn) throw new Error('JAWS MYOB connection not configured')

  // 3. Build MYOB Lines array
  const myobLines: any[] = []

  for (const ln of lines) {
    if (!ln.myob_item_uid) {
      throw new Error(`Order line ${ln.id} (${ln.sku}) has no MYOB item UID — cannot write to MYOB`)
    }
    const taxUid = ln.is_taxable !== false ? cfg.gstTaxCodeUid : cfg.freTaxCodeUid
    myobLines.push({
      Type: 'Transaction',
      Description: `${ln.name} — ${ln.sku}`.substring(0, 255),
      Item: { UID: ln.myob_item_uid },
      ShipQuantity: ln.qty,
      UnitPrice: round2(Number(ln.unit_trade_price_ex_gst || 0)),
      Total: round2(Number(ln.line_subtotal_ex_gst || 0)),
      TaxCode: { UID: taxUid },
    })
  }

  // Card surcharge line — uses a MYOB Service Item (e.g. "Bank Fees") so
  // every line on the order is an Item line. This avoids the "hybrid
  // layout" warning that AccountRight Desktop applies when an Item
  // invoice/order also has Account-only lines, which makes the transaction
  // read-only in Desktop. TaxCode is overridden to FRE so no GST is applied
  // to the surcharge (pure pass-through).
  const cardFeeInc = round2(Number(order.card_fee_inc || 0))
  if (cardFeeInc > 0) {
    myobLines.push({
      Type: 'Transaction',
      Description: 'Card processing surcharge',
      Item: { UID: cfg.cardFeeItemUid },
      ShipQuantity: 1,
      UnitPrice: cardFeeInc,
      Total: cardFeeInc,
      TaxCode: { UID: cfg.freTaxCodeUid },
    })
  }

  // 4. Compute envelope totals (ex-GST goods + ex-GST surcharge)
  const subtotalExGst = round2(Number(order.subtotal_ex_gst || 0))
  const totalTax      = round2(Number(order.gst || 0))
  const subtotalEnv   = round2(subtotalExGst + cardFeeInc)
  const totalAmount   = round2(subtotalEnv + totalTax)

  // 4b. Reserve the next portal-controlled MYOB number BEFORE the POST.
  const { data: rpcNumber, error: rpcErr } = await c.rpc('b2b_next_myob_invoice_number')
  if (rpcErr) throw new Error(`Failed to allocate MYOB order number: ${rpcErr.message}`)
  const myobOrderNumber = String(rpcNumber || '').trim()
  if (!myobOrderNumber) throw new Error('b2b_next_myob_invoice_number returned empty')

  const today = new Date().toISOString().substring(0, 10)
  const memo = `B2B Sale Order; Order ${order.order_number}; Stripe ${order.stripe_payment_intent_id || ''}`.substring(0, 255)
  const customerPo = (order.customer_po || '').trim().substring(0, 20)  // MYOB caps PO at 20 chars

  const body: Record<string, any> = {
    Customer: { UID: dist.myob_primary_customer_uid },
    Date: today,
    Number: myobOrderNumber,
    Lines: myobLines,
    IsTaxInclusive: false,
    FreightAmount: 0,
    FreightTaxCode: { UID: cfg.freTaxCodeUid },
    Subtotal: subtotalEnv,
    TotalTax: totalTax,
    TotalAmount: totalAmount,
    Comment: `Order ${order.order_number} — paid via JA Portal`,
    JournalMemo: memo,
  }
  if (customerPo) body.CustomerPurchaseOrderNumber = customerPo

  // 5. Bump attempt counter BEFORE the call (audit trail even if hang/crash)
  await c.from('b2b_orders')
    .update({ myob_write_attempts: (order.myob_write_attempts || 0) + 1 })
    .eq('id', orderId)

  // 6. POST to MYOB Sale.Order
  const path = `/accountright/${conn.company_file_id}/Sale/Order/Item`
  const result = await myobFetch(conn.id, path, {
    method: 'POST',
    body,
  })

  if (result.status !== 201 && result.status !== 200) {
    const errMsg = `MYOB Sale.Order POST failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 400)}`
    await c.from('b2b_orders')
      .update({
        myob_write_error: errMsg.substring(0, 1000),
      })
      .eq('id', orderId)
    throw new Error(errMsg)
  }

  // 7. Extract order UID from Location header (LAST UUID in the URL)
  const location = (result.headers || {})['location'] || (result.headers || {})['Location'] || ''
  const uuidMatches = String(location).match(UUID_REGEX_G) || []
  const orderUid = uuidMatches[uuidMatches.length - 1] || null
  if (!orderUid || orderUid === conn.company_file_id) {
    throw new Error(`MYOB returned 201 but no order UID in Location header: "${location}"`)
  }

  // 8. Fetch the created order to confirm Number
  let confirmedNumber: string | null = myobOrderNumber
  try {
    const detail = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Sale/Order/Item/${orderUid}`)
    if (detail.status === 200 && detail.data?.Number) {
      confirmedNumber = String(detail.data.Number)
    }
  } catch { /* not fatal — keep the reserved number */ }

  // 9. Save to order. Column names retained for backwards compat — they
  //    now hold an Order UID/Number, not an Invoice's.
  await c.from('b2b_orders')
    .update({
      myob_invoice_uid: orderUid,
      myob_invoice_number: confirmedNumber,
      myob_written_at: new Date().toISOString(),
      myob_write_error: null,
    })
    .eq('id', orderId)

  return {
    myob_invoice_uid: orderUid,
    myob_invoice_number: confirmedNumber,
    status: 'created',
  }
}
