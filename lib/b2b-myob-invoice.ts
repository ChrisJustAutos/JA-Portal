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
import { JAWS_UIDS } from './stripe-myob-sync'

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
      customer_po, shipping_address_snapshot,
      myob_invoice_uid, myob_invoice_number,
      myob_write_attempts, paid_at,
      stripe_payment_intent_id,
      distributor:b2b_distributors!b2b_orders_distributor_id_fkey (
        id, display_name, myob_primary_customer_uid,
        ship_line1, ship_line2, ship_suburb, ship_state, ship_postcode
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
    .select(`id, myob_item_uid, sku, name, qty, unit_trade_price_ex_gst, line_subtotal_ex_gst, line_gst, line_total_inc, is_taxable, sort_order, is_drop_ship,
      catalogue:b2b_catalogue!b2b_order_lines_catalogue_id_fkey ( rrp_ex_gst, myob_supplier_name, description )`)
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

  // Drop-ship lines carry a MYOB inventory Location (e.g. "MPI DS") so
  // supplier-shipped stock never moves through the main warehouse location
  // (Chris 2026-08-06). Looked up once per supplier, best-effort.
  const locationCache = new Map<string, string | null>()
  async function dropShipLocationUid(supplierName: string | null | undefined): Promise<string | null> {
    const key = String(supplierName || '').trim().toUpperCase()
    if (!key) return null
    if (locationCache.has(key)) return locationCache.get(key) ?? null
    let uid: string | null = null
    try {
      const r = await myobFetch(conn!.id, `/accountright/${conn!.company_file_id}/Inventory/Location`, { query: { '$top': 400 } })
      if (r.status === 200) {
        const locs: any[] = r.data?.Items || []
        const first = key.split(/\s+/)[0]
        const hit = locs.find(l => String(l.Name || '').toUpperCase() === `${first} DS`)
          || locs.find(l => String(l.Name || '').toUpperCase().startsWith(first) && /\bDS\b/i.test(String(l.Name || '')))
        uid = hit?.UID || null
      }
    } catch { /* best-effort — line just posts without a location */ }
    locationCache.set(key, uid)
    return uid
  }

  for (const ln of lines) {
    if (!ln.myob_item_uid) {
      throw new Error(`Order line ${ln.id} (${ln.sku}) has no MYOB item UID — cannot write to MYOB`)
    }
    const taxUid = ln.is_taxable !== false ? cfg.gstTaxCodeUid : cfg.freTaxCodeUid
    const cat: any = Array.isArray((ln as any).catalogue) ? (ln as any).catalogue[0] : (ln as any).catalogue
    // RRP on the line so the distributor sees retail next to their trade
    // price (Chris 2026-08-06). Inc-GST for taxable items.
    const rrpEx = cat?.rrp_ex_gst != null ? Number(cat.rrp_ex_gst) : null
    const rrpTxt = rrpEx && rrpEx > 0
      ? ` · RRP $${(ln.is_taxable !== false ? rrpEx * 1.1 : rrpEx).toFixed(2)}`
      : ''
    // Description = the MYOB item's own description (Chris 2026-08-06), not
    // our "name — sku" composite. The catalogue mirrors the item's sell
    // description at sync; fall back to the name if it's blank.
    const baseDesc = String(cat?.description || '').trim() || String(ln.name || ln.sku)
    // TAX-INCLUSIVE lines (Chris 2026-08-10: JAWSB2B0049 was 1c under the
    // Stripe charge). MYOB IGNORES posted envelope totals (calculated
    // fields) and re-derives tax itself — rounding ONCE on the total, while
    // checkout/Stripe round per line. Posting the EXACT inc-GST line amounts
    // Stripe charged (identical construction to checkout's line_items) makes
    // MYOB's TotalAmount equal the charge by definition; MYOB backs the GST
    // out of the inc figures instead of re-adding it.
    const lineEx = round2(Number(ln.line_subtotal_ex_gst || 0))
    const lineInc = ln.is_taxable !== false ? round2(lineEx + round2(lineEx * 0.10)) : lineEx
    const qty = Number(ln.qty) || 1
    const line: any = {
      Type: 'Transaction',
      Description: `${baseDesc}${rrpTxt}`.substring(0, 255),
      Item: { UID: ln.myob_item_uid },
      ShipQuantity: qty,
      UnitPrice: Math.round((lineInc / qty) * 1e5) / 1e5,   // inc per unit, 5dp
      Total: lineInc,
      TaxCode: { UID: taxUid },
    }
    if ((ln as any).is_drop_ship === true) {
      const locUid = await dropShipLocationUid(cat?.myob_supplier_name)
      if (locUid) line.Location = { UID: locUid }
    }
    myobLines.push(line)
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
  //   MYOB (IsTaxInclusive:true): TotalAmount = Σ(line inc Totals) + Freight(inc)
  // Freight inc mirrors checkout's Stripe freight line exactly:
  // ex + round2(ex × 10%) — NOT round2(ex × 1.1), which can differ by 1c.
  const freightExGst  = round2(Number(order.freight_cost_ex_gst || 0))
  const freightInc    = round2(freightExGst + round2(freightExGst * 0.10))
  const goodsIncSum   = round2(myobLines.reduce((s, l) => s + Number(l.Total || 0), 0))
  const totalTax      = round2(Number(order.gst || 0))               // informational — MYOB recomputes
  const subtotalEnv   = goodsIncSum                                  // inc, matches the lines
  const totalAmount   = round2(goodsIncSum + freightInc)             // = order.total_inc by construction
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

  // Ship-to: the checkout's shipping snapshot, falling back to the
  // distributor's card address (Chris 2026-08-06: invoices were arriving in
  // MYOB with no Ship To).
  const snap: any = (order as any).shipping_address_snapshot || {}
  const pickStr = (...vals: any[]): string => { for (const v of vals) { const s = String(v ?? '').trim(); if (s) return s } return '' }
  const shipToLines = [
    pickStr(snap.company_name, dist.display_name),
    pickStr(snap.recipient_name, snap.contact_name),
    pickStr(snap.line1, snap.address_line1, (dist as any).ship_line1),
    pickStr(snap.line2, snap.address_line2, (dist as any).ship_line2),
    [pickStr(snap.suburb, (dist as any).ship_suburb), pickStr(snap.state, (dist as any).ship_state), pickStr(snap.postcode, (dist as any).ship_postcode)].filter(Boolean).join(' '),
  ].filter((l, i, a) => l && a.indexOf(l) === i)
  const shipToAddress = shipToLines.join('\n').slice(0, 255)

  const body: Record<string, any> = {
    Customer: { UID: dist.myob_primary_customer_uid },
    Date: today,
    Number: myobOrderNumber,
    Lines: myobLines,
    IsTaxInclusive: true,
    Freight: freightInc,
    FreightTaxCode: { UID: freightTaxUid },
    Subtotal: subtotalEnv,
    TotalTax: totalTax,
    TotalAmount: totalAmount,
    JournalMemo: memo,
  }
  if (shipToAddress) body.ShipToAddress = shipToAddress
  // PO box next to the invoice number/date: the distributor's own PO when
  // they entered one, else our portal order number — NOT buried in the memo.
  // (Comment deliberately dropped — the JAWS invoice form prints it under a
  // "Vehicle" label, which made no sense on B2B orders. Chris 2026-08-06.)
  body.CustomerPurchaseOrderNumber = (customerPo || order.order_number || '').substring(0, 20)

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
  // TAX-INCLUSIVE lines, mirroring writeOrderToMyob and checkout's Stripe
  // line construction exactly (lineEx + round2(lineEx × 10%)) — MYOB ignores
  // posted envelope totals and re-derives tax rounding ONCE, which left
  // JAWSB2B0049 1c under the Stripe charge (Chris 2026-08-10). Posting the
  // inc figures makes MYOB's TotalAmount equal the charge by construction.
  const myobLines: any[] = []
  for (const ln of lines) {
    if (!ln.myob_item_uid) throw new Error(`Order line ${ln.id} (${ln.sku}) has no MYOB item UID`)
    const taxUid = ln.is_taxable !== false ? cfg.gstTaxCodeUid : cfg.freTaxCodeUid
    const lineEx = round2(Number(ln.line_subtotal_ex_gst || 0))
    const lineInc = ln.is_taxable !== false ? round2(lineEx + round2(lineEx * 0.10)) : lineEx
    const qty = Number(ln.qty) || 1
    myobLines.push({
      Type: 'Transaction',
      Description: `${ln.name} — ${ln.sku}`.substring(0, 255),
      Item: { UID: ln.myob_item_uid },
      ShipQuantity: qty,
      UnitPrice: Math.round((lineInc / qty) * 1e5) / 1e5,   // inc per unit, 5dp
      Total: lineInc,
      TaxCode: { UID: taxUid },
    })
  }
  const cardFeeInc = round2(Number(order.card_fee_inc || 0))
  if (cardFeeInc > 0) {
    myobLines.push({ Type: 'Transaction', Description: 'Card processing surcharge', Item: { UID: cfg.cardFeeItemUid }, ShipQuantity: 1, UnitPrice: cardFeeInc, Total: cardFeeInc, TaxCode: { UID: cfg.freTaxCodeUid } })
  }

  const freightExGst  = round2(Number(order.freight_cost_ex_gst || 0))
  const freightInc    = round2(freightExGst + round2(freightExGst * 0.10))
  const goodsIncSum   = round2(myobLines.reduce((s, l) => s + Number(l.Total || 0), 0))
  const totalTax      = round2(Number(order.gst || 0))    // informational — MYOB recomputes
  const subtotalEnv   = goodsIncSum
  const totalAmount   = round2(goodsIncSum + freightInc)  // = order.total_inc by construction
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
  // "Ship Via" = the carrier the order shipped by (MYOB ShippingMethod, a
  // string MYOB caps at 20 chars — longer got a 400 + retry-without round
  // trip on every conversion).
  const shipVia = String(opts.carrier ?? (order as any).carrier ?? '').trim().substring(0, 20)
  const body: Record<string, any> = {
    Customer: { UID: dist.myob_primary_customer_uid },
    Date: today,
    Number: number,
    Lines: myobLines,
    IsTaxInclusive: true,
    Freight: freightInc,
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
  appliedTo?: 'invoice' | 'order'
}

/**
 * Records the Stripe payment in MYOB as a Customer Payment deposited to
 * Undeposited Funds. Applied against the sale INVOICE when it exists;
 * otherwise against the open Sale ORDER (MYOB books it as a customer
 * deposit and carries it onto the invoice automatically at conversion) —
 * so paid orders show their money in MYOB immediately, even while a
 * drop-ship line keeps the invoice conversion waiting on the supplier.
 * Idempotent via b2b_orders.myob_payment_uid; also skips if the document's
 * balance is already 0 (e.g. someone receipted it manually).
 *
 * Only call once the money is actually settled — card/PayTo settle at
 * checkout; BECS settles days later (payment_settled_at is the gate).
 */
type MyobPaymentTarget = { uid: string; type: 'Invoice' | 'Order'; doc: any }

/**
 * Find the live MYOB document a settled payment should be applied to.
 *
 * The stored UID is a hint, not a fact. At checkout we record the Sale ORDER
 * we created (`myob_invoice_uid`); converting it to an invoice consumes that
 * document. Our own converter mints a NEW invoice UID and writes it back, but
 * a conversion done by hand in the MYOB UI writes nothing back — leaving the
 * order pointed at a document that no longer exists, so every UID-keyed gate
 * silently skips it. That stranded $4,074.46 on B2B-2026-000050 / JAWSB2B0059
 * for four days (Chris, 2026-08-31).
 *
 * So try, in order: the invoice we already know about; the stored UID as an
 * order; the same UID as an invoice (a UI conversion that kept it); and
 * finally the invoice carrying our order's Number (a conversion that didn't).
 * Returns null only when none of those exist in MYOB.
 */
async function resolvePaymentTarget(
  conn: { id: string; company_file_id: string | null },
  order: {
    myob_sale_invoice_uid: string | null
    myob_invoice_uid: string | null
    myob_invoice_number: string | null
  },
): Promise<MyobPaymentTarget | null> {
  const base = `/accountright/${conn.company_file_id}`
  const getDoc = async (path: string, uid: string): Promise<any | null> => {
    const r = await myobFetch(conn.id, `${base}/${path}/${uid}`)
    return r.status === 200 && r.data ? r.data : null
  }

  if (order.myob_sale_invoice_uid) {
    const doc = await getDoc('Sale/Invoice/Item', order.myob_sale_invoice_uid)
    if (doc) return { uid: order.myob_sale_invoice_uid, type: 'Invoice', doc }
  }

  if (order.myob_invoice_uid) {
    const asOrder = await getDoc('Sale/Order/Item', order.myob_invoice_uid)
    if (asOrder) return { uid: order.myob_invoice_uid, type: 'Order', doc: asOrder }
    const asInvoice = await getDoc('Sale/Invoice/Item', order.myob_invoice_uid)
    if (asInvoice) return { uid: order.myob_invoice_uid, type: 'Invoice', doc: asInvoice }
  }

  // Converted by hand under a new UID — the Number is carried across, and our
  // converter deliberately keeps it the same, so it identifies the invoice.
  const number = order.myob_invoice_number
  if (number) {
    const r = await myobFetch(conn.id, `${base}/Sale/Invoice/Item`, {
      query: { '$filter': `Number eq '${String(number).replace(/'/g, "''")}'`, '$top': 2 },
    })
    const items: any[] = r.status === 200 && Array.isArray(r.data?.Items) ? r.data.Items : []
    // Only trust an unambiguous match — two invoices sharing a Number means
    // something was duplicated by hand, and guessing would post to the wrong one.
    if (items.length === 1 && items[0]?.UID) {
      const full = await getDoc('Sale/Invoice/Item', items[0].UID)
      if (full) return { uid: items[0].UID, type: 'Invoice', doc: full }
    }
  }

  return null
}

export async function applyCustomerPaymentInMyob(orderId: string): Promise<MyobPaymentResult> {
  const c = sb()
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select(`
      id, order_number, total_inc, paid_at, payment_settled_at, payment_method,
      stripe_payment_intent_id, myob_payment_uid,
      myob_invoice_uid, myob_invoice_number,
      myob_sale_invoice_uid, myob_sale_invoice_number, myob_sale_invoice_at,
      distributor:b2b_distributors!b2b_orders_distributor_id_fkey ( id, display_name, myob_primary_customer_uid )
    `)
    .eq('id', orderId).maybeSingle()
  if (oErr) throw new Error(`Order load failed: ${oErr.message}`)
  if (!order) throw new Error(`Order ${orderId} not found`)

  if (order.myob_payment_uid) return { myob_payment_uid: order.myob_payment_uid, status: 'already_applied' }
  if (!order.myob_sale_invoice_uid && !order.myob_invoice_uid) return { myob_payment_uid: null, status: 'no_invoice' }
  if (!order.payment_settled_at) return { myob_payment_uid: null, status: 'not_settled' }

  const dist: any = Array.isArray(order.distributor) ? order.distributor[0] : order.distributor
  if (!dist?.myob_primary_customer_uid) throw new Error(`Distributor ${dist?.display_name || '?'} has no MYOB customer UID`)

  const conn = await getConnection('JAWS')
  if (!conn) throw new Error('JAWS MYOB connection not configured')

  // Work out what the money belongs on by READING MYOB, never by trusting the
  // stored UID alone — see resolvePaymentTarget.
  const target = await resolvePaymentTarget(conn, order as any)
  if (!target) return { myob_payment_uid: null, status: 'no_invoice' }
  const { uid: targetUid, type: targetType, doc } = target

  // If that turned up an invoice we didn't know about, record it, so the cron,
  // the Check payment button and Ship Now all stop chasing the dead order UID.
  if (targetType === 'Invoice' && targetUid !== order.myob_sale_invoice_uid) {
    await c.from('b2b_orders').update({
      myob_sale_invoice_uid: targetUid,
      myob_sale_invoice_number: doc.Number || order.myob_sale_invoice_number || order.myob_invoice_number || null,
      myob_sale_invoice_at: order.myob_sale_invoice_at || new Date().toISOString(),
    }).eq('id', orderId)
  }

  // Apply exactly the live balance (never more) — so a manual receipt in MYOB,
  // a rounding cent, or a partial doesn't double-pay.
  const balance = round2(Number(doc.BalanceDueAmount ?? 0))
  if (balance <= 0) {
    await c.from('b2b_orders').update({ myob_payment_at: new Date().toISOString() }).eq('id', orderId)
    return { myob_payment_uid: null, status: 'invoice_already_paid', appliedTo: targetType === 'Invoice' ? 'invoice' : 'order' }
  }
  const amount = Math.min(balance, round2(Number(order.total_inc || 0)) || balance)

  const payDate = String(order.payment_settled_at || order.paid_at || new Date().toISOString()).substring(0, 10)
  const memo = `Stripe ${order.stripe_payment_intent_id || ''} — Order ${order.order_number} (${order.payment_method || 'card'})`.substring(0, 255)

  const body: Record<string, any> = {
    DepositTo: 'UndepositedFunds',
    // MYOB rejects the payment with "Account is required" (ErrorCode 100)
    // even for UndepositedFunds — same shape the proven Stripe→MYOB sync
    // posts (JAWS 1-1210, seen live on B2B-2026-000040, 2026-08-06).
    Account: { UID: JAWS_UIDS.ACCT_UNDEP_FUNDS },
    Customer: { UID: dist.myob_primary_customer_uid },
    Date: payDate,
    AmountReceived: amount,
    Memo: memo,
    Invoices: [{ UID: targetUid, Type: targetType, AmountApplied: amount }],
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

  return { myob_payment_uid: paymentUid, status: 'created', appliedTo: targetType === 'Invoice' ? 'invoice' : 'order' }
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
  shape: 'mirror_full' | 'mirror_lines' | 'single_line'
}

// One selected order line of an item-selection refund, priced by the refund
// API (whole untouched lines use the stored checkout values; partial
// quantities re-derive from unit_ex with per-line rounding).
export interface RefundLineSelection {
  line_id: string
  sku: string
  name: string
  qty: number             // units refunded (≤ line.qty − line.refunded_qty)
  unit_ex: number         // unit_trade_price_ex_gst
  ex: number
  gst: number
  inc: number
  is_taxable: boolean | null
  myob_item_uid: string | null
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
 *   - Item-selection refund (meta.lineSelection): mirrors just the selected
 *     lines/quantities with negative totals — freight stays 0 (items only;
 *     freight refunds go through the amount modes).
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
  meta: { stripeRefundId?: string; reason?: string; lineSelection?: RefundLineSelection[] } = {},
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
  const selection     = !isFullMirror && meta.lineSelection && meta.lineSelection.length > 0 ? meta.lineSelection : null
  const shape: MyobCreditNoteResult['shape'] = isFullMirror ? 'mirror_full' : selection ? 'mirror_lines' : 'single_line'

  // Build the credit-note Lines
  const myobLines: any[] = []
  let subtotalEnv = 0
  let totalTax    = 0
  // Freight refunded via MYOB's native (negative) Freight field on a full
  // mirror. mirror_lines is items only (freight refunds use the amount
  // modes) and partials use a single catch-all line that already absorbs
  // any freight portion, so freight stays 0 for both.
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
  } else if (selection) {
    // Item-selection refund: mirror just the selected lines/quantities.
    // The API priced the selection — refuse if it doesn't sum to the refund.
    const selInc = round2(selection.reduce((s, l) => s + Number(l.inc || 0), 0))
    if (Math.abs(selInc - round2(refundAmount)) > 0.005) {
      throw new Error('Line selection total does not match refund amount')
    }
    for (const sel of selection) {
      if (!sel.myob_item_uid) {
        throw new Error(`Order line ${sel.sku} has no MYOB item UID — cannot mirror`)
      }
      const ex  = round2(Number(sel.ex || 0))
      const gst = round2(Number(sel.gst || 0))
      myobLines.push({
        Type: 'Transaction',
        Description: `Refund: ${sel.name} — ${sel.sku}`.substring(0, 255),
        Item: { UID: sel.myob_item_uid },
        ShipQuantity: -Number(sel.qty),
        UnitPrice: round2(Number(sel.unit_ex || 0)),
        Total: round2(-ex),
        TaxCode: { UID: sel.is_taxable !== false ? cfg.gstTaxCodeUid : cfg.freTaxCodeUid },
      })
      subtotalEnv += round2(-ex)
      totalTax    += round2(-gst)
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
    shape,
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
