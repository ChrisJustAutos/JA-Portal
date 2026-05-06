// lib/b2b-myob-invoice.ts
//
// Writes a paid B2B order to MYOB JAWS as a Sale.Invoice.
//
// Body shape (mirrors the AP bill code's lessons):
//   POST /accountright/{cf_id}/Sale/Invoice/Item
//   {
//     Customer: { UID },
//     Date,
//     Number,                    // optional, MYOB will assign one if omitted
//     Lines: [
//       { Type:'Transaction', Description, Item:{UID}, ShipQuantity, UnitPrice, Total, TaxCode:{UID} },  // catalogue lines
//       { Type:'Transaction', Description, Account:{UID}, Total, TaxCode:{UID} },                        // surcharge line
//     ],
//     IsTaxInclusive: false,
//     FreightAmount: 0,
//     FreightTaxCode: { UID },   // required even at 0 (FRE)
//     Subtotal, TotalTax, TotalAmount,
//     JournalMemo, Comment,
//   }
//
// Idempotent: if order.myob_invoice_uid is already set, no-op and return existing.
// On HTTP 201 the UID comes back in the `Location` response header
// (the LAST UUID in the URL — there are two: cfId + invoice UID).

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
 * Writes the given paid order to MYOB. Throws on failure (caller is the
 * Stripe webhook, which will retry on next webhook delivery if Stripe
 * resends — Stripe will retry up to 3 days for non-200 responses).
 */
export async function writeOrderToMyob(orderId: string): Promise<MyobWriteResult> {
  const c = sb()

  // 1. Load order + lines + distributor (for customer UID)
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select(`
      id, order_number, status,
      subtotal_ex_gst, gst, card_fee_inc, total_inc, currency,
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

  // Card surcharge line — no GST (pure pass-through)
  const cardFeeInc = round2(Number(order.card_fee_inc || 0))
  if (cardFeeInc > 0) {
    myobLines.push({
      Type: 'Transaction',
      Description: 'Card processing surcharge',
      Account: { UID: cfg.cardFeeAccountUid },
      Total: cardFeeInc,
      TaxCode: { UID: cfg.freTaxCodeUid },
    })
  }

  // 4. Compute envelope totals (ex-GST goods + ex-GST surcharge)
  const subtotalExGst = round2(Number(order.subtotal_ex_gst || 0))
  const totalTax      = round2(Number(order.gst || 0))
  const subtotalEnv   = round2(subtotalExGst + cardFeeInc)
  const totalAmount   = round2(subtotalEnv + totalTax)

  const today = new Date().toISOString().substring(0, 10)
  const memo = `B2B Sale; Order ${order.order_number}; Stripe ${order.stripe_payment_intent_id || ''}`.substring(0, 255)

  const body = {
    Customer: { UID: dist.myob_primary_customer_uid },
    Date: today,
    Number: order.order_number,  // MYOB will accept; needs to fit MYOB's number length limit
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

  // 5. Bump attempt counter BEFORE the call so we have an audit trail even if
  // the call hangs / process dies mid-flight.
  await c.from('b2b_orders')
    .update({ myob_write_attempts: (order.myob_write_attempts || 0) + 1 })
    .eq('id', orderId)

  // 6. POST to MYOB
  const path = `/accountright/${conn.company_file_id}/Sale/Invoice/Item`
  const result = await myobFetch(conn.id, path, {
    method: 'POST',
    body,
  })

  if (result.status !== 201 && result.status !== 200) {
    const errMsg = `MYOB Sale.Invoice POST failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 400)}`
    await c.from('b2b_orders')
      .update({
        myob_write_error: errMsg.substring(0, 1000),
      })
      .eq('id', orderId)
    throw new Error(errMsg)
  }

  // 7. Extract invoice UID from Location header (LAST UUID in the URL)
  const location = (result.headers || {})['location'] || (result.headers || {})['Location'] || ''
  const uuidMatches = String(location).match(UUID_REGEX_G) || []
  // Two UUIDs in a typical URL: cfId then invoiceUid. Take last.
  const invoiceUid = uuidMatches[uuidMatches.length - 1] || null
  // Sanity: if location only had one UUID and it equals cfId, that's a bug, not our invoice.
  if (!invoiceUid || invoiceUid === conn.company_file_id) {
    throw new Error(`MYOB returned 201 but no invoice UID in Location header: "${location}"`)
  }

  // 8. Fetch the created invoice to get its assigned Number (in case MYOB
  // overrode our suggested Number)
  let invoiceNumber: string | null = order.order_number
  try {
    const detail = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Sale/Invoice/Item/${invoiceUid}`)
    if (detail.status === 200 && detail.data?.Number) {
      invoiceNumber = String(detail.data.Number)
    }
  } catch { /* not fatal — keep our order number */ }

  // 9. Save to order
  await c.from('b2b_orders')
    .update({
      myob_invoice_uid: invoiceUid,
      myob_invoice_number: invoiceNumber,
      myob_written_at: new Date().toISOString(),
      myob_write_error: null,
    })
    .eq('id', orderId)

  return {
    myob_invoice_uid: invoiceUid,
    myob_invoice_number: invoiceNumber,
    status: 'created',
  }
}
