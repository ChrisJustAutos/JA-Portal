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
//     Freight: 0,
//     FreightTaxCode: { UID },
//     Subtotal, TotalTax, TotalAmount,
//     JournalMemo, Comment,
//   }
//
// Idempotent: if order.myob_invoice_uid is already set, no-op and return existing.
// (Column names retained as `myob_invoice_*` for backwards compat — they
//  now hold an Order UID/Number rather than an Invoice UID/Number.)

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch, myobFetchPdf } from './myob'
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
      freight_cost_ex_gst,
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

  // 4. Compute envelope totals.
  //
  // order.subtotal_ex_gst and order.gst already INCLUDE freight (checkout
  // folds it in). MYOB models freight separately via its top-level Freight field (NOT 'FreightAmount' — MYOB silently ignores unknown attributes, which is how freight vanished from May-July 2026 orders), so we
  // back the freight out of the line subtotal and hand it to MYOB's native
  // freight field — otherwise the goods lines wouldn't reconcile and the
  // freight portion silently vanished from the posted invoice.
  //
  //   MYOB: TotalAmount = Subtotal (sum of line Totals) + Freight + TotalTax
  const freightExGst  = round2(Number(order.freight_cost_ex_gst || 0))
  const subtotalExGst = round2(Number(order.subtotal_ex_gst || 0))   // goods + freight (ex GST)
  const goodsExGst    = round2(subtotalExGst - freightExGst)         // goods only (matches product lines)
  const totalTax      = round2(Number(order.gst || 0))               // products GST + freight GST
  const subtotalEnv   = round2(goodsExGst + cardFeeInc)              // sum of myobLines (products + surcharge)
  const totalAmount   = round2(subtotalEnv + freightExGst + totalTax)
  // Freight is GST-taxable in the portal, so book it against GST when
  // present; fall back to FRE when there's no freight so the field is valid.
  const freightTaxUid = freightExGst > 0 ? cfg.gstTaxCodeUid : cfg.freTaxCodeUid

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
    Freight: freightExGst,
    FreightTaxCode: { UID: freightTaxUid },
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

// ─── Convert Sale.Order → Sale.Invoice (on shipment) ───────────────────

export interface MyobConvertResult {
  myob_sale_invoice_uid: string
  myob_sale_invoice_number: string | null
  status: 'created' | 'already_converted'
}

/**
 * Converts the order's MYOB Sale.Order into a Sale.Invoice (hits the GL) when
 * Just Autos ships it, using MYOB's NATIVE conversion: POST /Sale/Invoice/Item
 * with the order's lines/freight/surcharge PLUS an `Order: { UID }` link to the
 * originating order. AccountRight consumes/closes that order (no delete, no
 * duplicate). Keeps the SAME Number for continuity. Idempotent via
 * b2b_orders.myob_sale_invoice_uid. Throws on failure (caller logs best-effort).
 */
// Find a MYOB employee card UID by name (for the invoice Salesperson). Matches
// Name/DisplayID/CompanyName/LastName case-insensitively. Best-effort: null on
// any miss so it never blocks the invoice.
async function findSalespersonUid(connId: string, cfId: string | null, name: string): Promise<string | null> {
  const t = name.trim().toLowerCase()
  if (!t || !cfId) return null
  try {
    const r = await myobFetch(connId, `/accountright/${cfId}/Contact/Employee`, { query: { '$top': 1000 } })
    if (r.status !== 200) return null
    const items: any[] = r.data?.Items || []
    const m = items.find(e => [e.Name, e.DisplayID, e.CompanyName, e.LastName, `${e.FirstName || ''} ${e.LastName || ''}`.trim()]
      .some(v => String(v || '').trim().toLowerCase() === t))
    return m?.UID || null
  } catch { return null }
}

export async function convertOrderToInvoiceInMyob(orderId: string, opts: { trackingNumber?: string | null; carrier?: string | null } = {}): Promise<MyobConvertResult> {
  const c = sb()
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select(`
      id, order_number, status,
      subtotal_ex_gst, gst, card_fee_inc, total_inc,
      freight_cost_ex_gst, customer_po, tracking_number, carrier,
      myob_invoice_uid, myob_invoice_number,
      myob_sale_invoice_uid, myob_sale_invoice_number,
      stripe_payment_intent_id,
      distributor:b2b_distributors!b2b_orders_distributor_id_fkey ( id, display_name, myob_primary_customer_uid )
    `)
    .eq('id', orderId).maybeSingle()
  if (oErr) throw new Error(`Order load failed: ${oErr.message}`)
  if (!order) throw new Error(`Order ${orderId} not found`)

  if (order.myob_sale_invoice_uid) {
    return { myob_sale_invoice_uid: order.myob_sale_invoice_uid, myob_sale_invoice_number: order.myob_sale_invoice_number, status: 'already_converted' }
  }

  const dist: any = Array.isArray(order.distributor) ? order.distributor[0] : order.distributor
  if (!dist?.myob_primary_customer_uid) throw new Error(`Distributor ${dist?.display_name || dist?.id} has no MYOB customer UID`)

  const { data: lines, error: lErr } = await c
    .from('b2b_order_lines')
    .select('id, myob_item_uid, sku, name, qty, unit_trade_price_ex_gst, line_subtotal_ex_gst, is_taxable, sort_order')
    .eq('order_id', orderId).order('sort_order', { ascending: true })
  if (lErr) throw new Error(`Order lines load failed: ${lErr.message}`)
  if (!lines || lines.length === 0) throw new Error(`Order ${orderId} has no lines`)

  const cfg = await assertCheckoutConfigured()
  const conn = await getConnection('JAWS')
  if (!conn) throw new Error('JAWS MYOB connection not configured')

  // Build the invoice lines (identical mapping to writeOrderToMyob's order lines).
  const myobLines: any[] = []
  for (const ln of lines) {
    if (!ln.myob_item_uid) throw new Error(`Order line ${ln.id} (${ln.sku}) has no MYOB item UID`)
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
  const cardFeeInc = round2(Number(order.card_fee_inc || 0))
  if (cardFeeInc > 0) {
    myobLines.push({ Type: 'Transaction', Description: 'Card processing surcharge', Item: { UID: cfg.cardFeeItemUid }, ShipQuantity: 1, UnitPrice: cardFeeInc, Total: cardFeeInc, TaxCode: { UID: cfg.freTaxCodeUid } })
  }

  const freightExGst  = round2(Number(order.freight_cost_ex_gst || 0))
  const subtotalExGst = round2(Number(order.subtotal_ex_gst || 0))
  const goodsExGst    = round2(subtotalExGst - freightExGst)
  const totalTax      = round2(Number(order.gst || 0))
  const subtotalEnv   = round2(goodsExGst + cardFeeInc)
  const totalAmount   = round2(subtotalEnv + freightExGst + totalTax)
  const freightTaxUid = freightExGst > 0 ? cfg.gstTaxCodeUid : cfg.freTaxCodeUid

  // Keep the same Number as the order for continuity. Fall back to a freshly
  // reserved number if the order was never written (no number on file).
  let number = (order.myob_sale_invoice_number || order.myob_invoice_number || '').trim()
  if (!number) {
    const { data: rpcNumber, error: rpcErr } = await c.rpc('b2b_next_myob_invoice_number')
    if (rpcErr) throw new Error(`Failed to allocate MYOB invoice number: ${rpcErr.message}`)
    number = String(rpcNumber || '').trim()
  }
  if (!number) throw new Error('Could not resolve a MYOB invoice number')

  const today = new Date().toISOString().substring(0, 10)
  const memo = `B2B Tax Invoice; Order ${order.order_number}; Stripe ${order.stripe_payment_intent_id || ''}`.substring(0, 255)
  const customerPo = (order.customer_po || '').trim().substring(0, 20)
  // The invoice template's "Tracking No:" box is bound to the Comment field, so
  // put the carrier tracking number there. Falls back to the stored value, then
  // blank (rather than descriptive text, which would read oddly on the form).
  const tracking = String(opts.trackingNumber ?? (order as any).tracking_number ?? '').trim().substring(0, 255)
  // "Ship Via" = the carrier the order shipped by (MYOB ShippingMethod, a string).
  const shipVia = String(opts.carrier ?? (order as any).carrier ?? '').trim().substring(0, 36)
  const body: Record<string, any> = {
    Customer: { UID: dist.myob_primary_customer_uid },
    Date: today,
    Number: number,
    Lines: myobLines,
    IsTaxInclusive: false,
    Freight: freightExGst,
    FreightTaxCode: { UID: freightTaxUid },
    Subtotal: subtotalEnv,
    TotalTax: totalTax,
    TotalAmount: totalAmount,
    Comment: tracking,   // → prints in the template's "Tracking No:" box
    JournalMemo: memo,
  }
  if (customerPo) body.CustomerPurchaseOrderNumber = customerPo

  // Native MYOB conversion: link the new invoice to the originating order via
  // the Order foreign key. AccountRight then CONVERTS the order (consumes/closes
  // it) rather than leaving a duplicate — no delete needed. Requires the invoice
  // layout to match the order's (both Item layout here). If the order was never
  // written to MYOB (no UID), this is just a fresh invoice.
  if (order.myob_invoice_uid) body.Order = { UID: order.myob_invoice_uid }

  // Optional, cosmetic form fields: "Ship Via" (carrier) and Salesperson. These
  // are added best-effort — if MYOB rejects either, we retry the POST WITHOUT
  // them so a cosmetic field can never block creating the GL invoice.
  const optionalKeys: string[] = []
  if (shipVia) { body.ShippingMethod = shipVia; optionalKeys.push('ShippingMethod') }
  const spUid = await findSalespersonUid(conn.id, conn.company_file_id, (process.env.B2B_MYOB_SALESPERSON || 'B2B').trim())
  if (spUid) { body.Salesperson = { UID: spUid }; optionalKeys.push('Salesperson') }

  // Create the invoice (hits the GL; converts the linked order).
  const path = `/accountright/${conn.company_file_id}/Sale/Invoice/Item`
  let result = await myobFetch(conn.id, path, { method: 'POST', body })
  if (result.status === 400 && optionalKeys.length) {
    // A validation error (nothing created) — strip the optional fields and retry once.
    console.error(`convert: invoice POST 400, retrying without ${optionalKeys.join(', ')}: ${(result.raw || '').substring(0, 200)}`)
    for (const k of optionalKeys) delete body[k]
    result = await myobFetch(conn.id, path, { method: 'POST', body })
  }
  if (result.status !== 201 && result.status !== 200) {
    throw new Error(`MYOB Sale.Invoice POST failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 400)}`)
  }
  const location = (result.headers || {})['location'] || (result.headers || {})['Location'] || ''
  const uuidMatches = String(location).match(UUID_REGEX_G) || []
  const invoiceUid = uuidMatches[uuidMatches.length - 1] || null
  if (!invoiceUid || invoiceUid === conn.company_file_id) throw new Error(`MYOB returned 201 but no invoice UID in Location: "${location}"`)

  await c.from('b2b_orders').update({
    myob_sale_invoice_uid: invoiceUid,
    myob_sale_invoice_number: number,
    myob_sale_invoice_at: new Date().toISOString(),
  }).eq('id', orderId)

  return { myob_sale_invoice_uid: invoiceUid, myob_sale_invoice_number: number, status: 'created' }
}

// ─── Customer payment (Stripe → Undeposited Funds) ─────────────────────

export interface MyobPaymentResult {
  myob_payment_uid: string | null
  status: 'created' | 'already_applied' | 'invoice_already_paid' | 'not_settled' | 'no_invoice'
}

/**
 * Records the Stripe payment against the order's MYOB sale invoice as a
 * Customer Payment deposited to Undeposited Funds, so the invoice shows PAID
 * in MYOB. Idempotent via b2b_orders.myob_payment_uid; also skips if the
 * invoice balance is already 0 (e.g. someone receipted it manually).
 *
 * Only call once the money is actually settled — card/PayTo settle at
 * checkout; BECS settles days later (payment_settled_at is the gate).
 */
export async function applyCustomerPaymentInMyob(orderId: string): Promise<MyobPaymentResult> {
  const c = sb()
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select(`
      id, order_number, total_inc, paid_at, payment_settled_at, payment_method,
      stripe_payment_intent_id, myob_sale_invoice_uid, myob_payment_uid,
      distributor:b2b_distributors!b2b_orders_distributor_id_fkey ( id, display_name, myob_primary_customer_uid )
    `)
    .eq('id', orderId).maybeSingle()
  if (oErr) throw new Error(`Order load failed: ${oErr.message}`)
  if (!order) throw new Error(`Order ${orderId} not found`)

  if (order.myob_payment_uid) return { myob_payment_uid: order.myob_payment_uid, status: 'already_applied' }
  if (!order.myob_sale_invoice_uid) return { myob_payment_uid: null, status: 'no_invoice' }
  if (!order.payment_settled_at) return { myob_payment_uid: null, status: 'not_settled' }

  const dist: any = Array.isArray(order.distributor) ? order.distributor[0] : order.distributor
  if (!dist?.myob_primary_customer_uid) throw new Error(`Distributor ${dist?.display_name || '?'} has no MYOB customer UID`)

  const conn = await getConnection('JAWS')
  if (!conn) throw new Error('JAWS MYOB connection not configured')

  // Read the invoice's live balance and apply exactly that (never more) — so a
  // manual receipt in MYOB, a rounding cent, or a partial doesn't double-pay.
  const inv = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Sale/Invoice/Item/${order.myob_sale_invoice_uid}`)
  if (inv.status !== 200 || !inv.data) throw new Error(`Invoice fetch failed (HTTP ${inv.status})`)
  const balance = round2(Number(inv.data.BalanceDueAmount ?? 0))
  if (balance <= 0) {
    await c.from('b2b_orders').update({ myob_payment_at: new Date().toISOString() }).eq('id', orderId)
    return { myob_payment_uid: null, status: 'invoice_already_paid' }
  }
  const amount = Math.min(balance, round2(Number(order.total_inc || 0)) || balance)

  const payDate = String(order.payment_settled_at || order.paid_at || new Date().toISOString()).substring(0, 10)
  const memo = `Stripe ${order.stripe_payment_intent_id || ''} — Order ${order.order_number} (${order.payment_method || 'card'})`.substring(0, 255)

  const body: Record<string, any> = {
    DepositTo: 'UndepositedFunds',
    Customer: { UID: dist.myob_primary_customer_uid },
    Date: payDate,
    AmountReceived: amount,
    Memo: memo,
    Invoices: [{ UID: order.myob_sale_invoice_uid, Type: 'Invoice', AmountApplied: amount }],
  }

  const result = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Sale/CustomerPayment`, { method: 'POST', body })
  if (result.status !== 201 && result.status !== 200) {
    throw new Error(`MYOB CustomerPayment POST failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 400)}`)
  }
  const location = (result.headers || {})['location'] || ''
  const uuidMatches = String(location).match(UUID_REGEX_G) || []
  const paymentUid = uuidMatches[uuidMatches.length - 1] || null
  if (!paymentUid || paymentUid === conn.company_file_id) throw new Error(`MYOB returned 201 but no payment UID in Location: "${location}"`)

  await c.from('b2b_orders').update({
    myob_payment_uid: paymentUid,
    myob_payment_at: new Date().toISOString(),
  }).eq('id', orderId)

  return { myob_payment_uid: paymentUid, status: 'created' }
}

/**
 * Deletes the order's MYOB Sale.ORDER (pre-shipment, no GL impact). Used when
 * a full refund lands before the order was ever converted to an invoice — a
 * credit note would corrupt the GL (credit with no matching sale), and the
 * open Sale.Order would otherwise sit in the register ready to be shipped.
 */
export async function deleteMyobSaleOrder(orderId: string): Promise<{ deleted: boolean; reason?: string }> {
  const c = sb()
  const { data: order } = await c.from('b2b_orders')
    .select('myob_invoice_uid, myob_sale_invoice_uid').eq('id', orderId).maybeSingle()
  if (!order?.myob_invoice_uid) return { deleted: false, reason: 'no MYOB order on file' }
  if (order.myob_sale_invoice_uid) return { deleted: false, reason: 'order already converted to an invoice — credit note path applies' }

  const conn = await getConnection('JAWS')
  if (!conn) throw new Error('JAWS MYOB connection not configured')
  const result = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Sale/Order/Item/${order.myob_invoice_uid}`, { method: 'DELETE' })
  if (result.status === 404) return { deleted: false, reason: 'MYOB order not found (already deleted?)' }
  if (result.status !== 200 && result.status !== 204) {
    throw new Error(`MYOB Sale.Order DELETE failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 300)}`)
  }
  return { deleted: true }
}

// ─── Refund credit note ────────────────────────────────────────────────

export interface MyobCreditNoteResult {
  credit_note_uid: string
  credit_note_number: string
  amount: number          // positive — the refund value (credit note totals are negative)
  shape: 'mirror_full' | 'single_line'
}

/**
 * Creates a credit note (negative-amount Sale.Invoice) in MYOB JAWS to
 * mirror a Stripe refund. Posts to /Sale/Invoice/Item rather than
 * /Sale/Order so the credit hits the GL immediately and shows up under
 * the customer's record in MYOB.
 *
 *   - Full refund (no prior refunds): mirrors all original lines with
 *     negative quantities/totals — clean reversal that nets the original
 *     order to zero on the customer ledger.
 *   - Partial / additional refund: single line for the refund amount,
 *     using the Bank Fees item with FRE tax. (Tax treatment is approximate
 *     for partials — staff can refine the GST split manually if needed.)
 *
 * Numbering: pulls the next number from `b2b_next_myob_credit_note_number`,
 * which is a separate stream from order invoices (default prefix "CR").
 * Configured via b2b_settings.myob_credit_note_number_* on the admin Settings page.
 *
 * Throws on failure. The caller (refund API) catches the throw and logs
 * it as a non-fatal warning event — the Stripe refund stays valid even
 * if the MYOB credit note fails (Stripe is the source of truth for cash).
 */
export async function writeRefundCreditNoteToMyob(
  orderId: string,
  refundAmount: number,
  meta: { stripeRefundId?: string; reason?: string } = {},
): Promise<MyobCreditNoteResult> {
  const c = sb()

  // Load order + lines + distributor + the surcharge value
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select(`
      id, order_number, customer_po,
      total_inc, refunded_total, card_fee_inc, freight_cost_ex_gst,
      stripe_payment_intent_id,
      myob_invoice_number,
      distributor:b2b_distributors!b2b_orders_distributor_id_fkey (
        id, display_name, myob_primary_customer_uid
      )
    `)
    .eq('id', orderId)
    .maybeSingle()
  if (oErr) throw new Error(`Order load failed: ${oErr.message}`)
  if (!order) throw new Error(`Order ${orderId} not found`)

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

  const cfg = await assertCheckoutConfigured()
  const conn = await getConnection('JAWS')
  if (!conn) throw new Error('JAWS MYOB connection not configured')

  const totalInc      = round2(Number(order.total_inc || 0))
  const cardFeeInc    = round2(Number(order.card_fee_inc || 0))
  // refunded_total INCLUDES the current refund (caller has already updated it).
  // Prior refunds = current refunded_total minus this refund amount.
  const priorRefunded = round2(Number(order.refunded_total || 0)) - round2(refundAmount)
  const isFullMirror  = Math.abs(refundAmount - totalInc) < 0.005 && Math.abs(priorRefunded) < 0.005

  // Build the credit-note Lines
  const myobLines: any[] = []
  let subtotalEnv = 0
  let totalTax    = 0
  // Freight refunded via MYOB's native (negative) Freight field on a full
  // mirror. Partial refunds use a single catch-all line that already
  // absorbs any freight portion, so freight stays 0 there.
  let freightRefundEx = 0

  if (isFullMirror) {
    for (const ln of lines) {
      if (!ln.myob_item_uid) {
        throw new Error(`Order line ${ln.sku} has no MYOB item UID — cannot mirror`)
      }
      const taxUid  = ln.is_taxable !== false ? cfg.gstTaxCodeUid : cfg.freTaxCodeUid
      const lineEx  = round2(-Number(ln.line_subtotal_ex_gst || 0))
      const lineGst = ln.is_taxable !== false ? round2(-Number(ln.line_gst || 0)) : 0
      myobLines.push({
        Type: 'Transaction',
        Description: `Refund: ${ln.name} — ${ln.sku}`.substring(0, 255),
        Item: { UID: ln.myob_item_uid },
        ShipQuantity: -Number(ln.qty),
        UnitPrice: round2(Number(ln.unit_trade_price_ex_gst || 0)),
        Total: lineEx,
        TaxCode: { UID: taxUid },
      })
      subtotalEnv += lineEx
      totalTax    += lineGst
    }

    // Mirror the original card surcharge line (negative qty, FRE)
    if (cardFeeInc > 0) {
      myobLines.push({
        Type: 'Transaction',
        Description: 'Card processing surcharge — refund',
        Item: { UID: cfg.cardFeeItemUid },
        ShipQuantity: -1,                       // negative qty drives negative total
        UnitPrice: round2(cardFeeInc),          // positive (MYOB rejects negative UnitPrice)
        Total: round2(-cardFeeInc),
        TaxCode: { UID: cfg.freTaxCodeUid },
      })
      subtotalEnv += round2(-cardFeeInc)
    }

    // Mirror freight via MYOB's native freight field (negative on a
    // credit note). GST-taxable, so add the negative freight GST to the
    // running tax. Without this a full refund under-credits by freight.
    const freightExGst = round2(Number(order.freight_cost_ex_gst || 0))
    if (freightExGst > 0) {
      freightRefundEx = round2(-freightExGst)
      totalTax += round2(-freightExGst * 0.10)   // freight GST @ 10%
    }
  } else {
    // Single-line credit note for partial / additional refunds
    const refundPos = round2(refundAmount)
    myobLines.push({
      Type: 'Transaction',
      Description: `Refund — Order ${order.order_number}`.substring(0, 255),
      Item: { UID: cfg.cardFeeItemUid },
      ShipQuantity: -1,                         // negative qty drives negative total
      UnitPrice: refundPos,                     // positive (MYOB rejects negative UnitPrice)
      Total: round2(-refundPos),
      TaxCode: { UID: cfg.freTaxCodeUid },
    })
    subtotalEnv = round2(-refundPos)
    totalTax    = 0
  }

  subtotalEnv = round2(subtotalEnv)
  totalTax    = round2(totalTax)
  const totalAmount = round2(subtotalEnv + freightRefundEx + totalTax)

  // Reserve the next number from the credit-note sequence (independent of invoices)
  const { data: rpcNumber, error: rpcErr } = await c.rpc('b2b_next_myob_credit_note_number')
  if (rpcErr) throw new Error(`Failed to allocate credit note number: ${rpcErr.message}`)
  const creditNumber = String(rpcNumber || '').trim()
  if (!creditNumber) throw new Error('b2b_next_myob_credit_note_number returned empty')

  const today = new Date().toISOString().substring(0, 10)
  const refundIdMemo = meta.stripeRefundId ? `; Stripe refund ${meta.stripeRefundId}` : ''
  const memo = `B2B Refund credit note; Order ${order.order_number}${refundIdMemo}`.substring(0, 255)
  const customerPo = (order.customer_po || '').trim().substring(0, 20)

  const body: Record<string, any> = {
    Customer: { UID: dist.myob_primary_customer_uid },
    Date: today,
    Number: creditNumber,
    Lines: myobLines,
    IsTaxInclusive: false,
    Freight: freightRefundEx,
    FreightTaxCode: { UID: freightRefundEx !== 0 ? cfg.gstTaxCodeUid : cfg.freTaxCodeUid },
    Subtotal: subtotalEnv,
    TotalTax: totalTax,
    TotalAmount: totalAmount,
    Comment: `Credit note for refund of order ${order.order_number}${meta.reason ? ` (${meta.reason.replace(/_/g, ' ')})` : ''}`,
    JournalMemo: memo,
  }
  if (customerPo) body.CustomerPurchaseOrderNumber = customerPo

  // POST to /Sale/Invoice/Item (NOT /Sale/Order — credits need to hit GL)
  const path = `/accountright/${conn.company_file_id}/Sale/Invoice/Item`
  const result = await myobFetch(conn.id, path, { method: 'POST', body })

  if (result.status !== 201 && result.status !== 200) {
    throw new Error(
      `MYOB credit note POST failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 400)}`,
    )
  }

  // Extract UID from Location header
  const location = (result.headers || {})['location'] || (result.headers || {})['Location'] || ''
  const uuidMatches = String(location).match(UUID_REGEX_G) || []
  const creditUid = uuidMatches[uuidMatches.length - 1] || null
  if (!creditUid || creditUid === conn.company_file_id) {
    throw new Error(`MYOB returned 201 but no credit note UID in Location header: "${location}"`)
  }

  return {
    credit_note_uid:    creditUid,
    credit_note_number: creditNumber,
    amount:             round2(refundAmount),
    shape:              isFullMirror ? 'mirror_full' : 'single_line',
  }
}

// Fetch the actual MYOB tax-invoice PDF for an order (the converted
// Sale/Invoice/Item), rendered by MYOB with its default print template. Returns
// null (never throws) if the order isn't an invoice yet, MYOB isn't connected,
// or MYOB doesn't return a PDF — callers fall back to the system-generated PDF.
export async function getMyobInvoicePdf(orderId: string): Promise<{ buffer: Buffer; filename: string } | null> {
  try {
    const { data: order } = await sb().from('b2b_orders')
      .select('myob_sale_invoice_uid, myob_sale_invoice_number, myob_invoice_number, order_number')
      .eq('id', orderId).maybeSingle()
    const uid = (order as any)?.myob_sale_invoice_uid as string | null
    if (!uid) return null   // only a converted INVOICE has a printable invoice PDF
    const conn = await getConnection('JAWS')
    if (!conn) return null
    const num = String((order as any)?.myob_sale_invoice_number || (order as any)?.myob_invoice_number || (order as any)?.order_number || orderId)
    // Render with the configured MYOB form template (e.g. the JAWS item-invoice
    // template) rather than MYOB's default. Set B2B_MYOB_INVOICE_TEMPLATE to the
    // EXACT template name from MYOB → Setup → Customise Forms.
    const tpl = (process.env.B2B_MYOB_INVOICE_TEMPLATE || '').trim()
    const q = tpl ? `?templateName=${encodeURIComponent(tpl)}` : ''
    const pdf = await myobFetchPdf(conn.id, `/accountright/${conn.company_file_id}/Sale/Invoice/Item/${uid}${q}`)
    return { buffer: Buffer.from(pdf.base64, 'base64'), filename: `Invoice-${num.replace(/[^\w.\-]/g, '_')}.pdf` }
  } catch (e: any) {
    console.error('getMyobInvoicePdf failed (will fall back to system PDF):', e?.message || e)
    return null
  }
}
