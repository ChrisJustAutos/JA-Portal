// lib/accounting/post-b2b-doc.ts
//
// Provider seam for the B2B module (MYOB → Xero migration).
//
// Thin wrappers over lib/b2b-myob-invoice.ts + lib/b2b-myob-po.ts with the
// SAME exported names and signatures the B2B callers already use. Every
// wrapper consults accountingProvider('JAWS', 'B2B') — THE SWITCH:
//
//   'myob' (the default) → delegate straight through to the existing,
//          battle-tested MYOB functions. Behaviour is byte-identical.
//   'xero' → translate the B2B document through the XeroAdapter.
//
// NOTE on the adapter import: lib/accounting/xero-adapter.ts still carries
// its own local contract types (the seam agent reconciles it to ./types
// later), so this file uses the CONCRETE XeroAdapter class + its actual
// signatures rather than getAccountingAdapter()'s neutral cast — that cast
// is not yet runtime-safe for Xero.
//
// Xero translation decisions (see each function for detail):
//   • Xero has NO Sale Orders — a paid B2B order posts as an ACCREC invoice
//     with status DRAFT (no GL impact until authorised), mirroring MYOB's
//     Sale.Order semantics.
//   • Xero has NO native order→invoice conversion, and the adapter exposes
//     no authorise-a-draft operation yet — conversion returns a clear
//     not-yet-supported error (callers already treat it as best-effort).
//   • MYOB freight is a HEADER field; Xero has none — freight posts as its
//     own GST-inclusive LINE ITEM.
//   • Item-level MYOB item UIDs have no Xero mapping yet — product lines
//     post as description-only lines (qty folded into the description; the
//     adapter posts Quantity 1 / UnitAmount = line total).
//   • Contacts resolve distributor-first: b2b_distributors.xero_contact_id
//     → xero_contact_map (by the distributor's MYOB customer UID) →
//     adapter.findContact by name → adapter.createContact; every hit is
//     persisted back to BOTH b2b_distributors.xero_contact_id and
//     xero_contact_map so the next order skips the hunt.
//   • Accounts resolve through xero_account_map (entity 'JAWS') under
//     documented SENTINEL keys (there is no MYOB DisplayID on B2B order
//     lines — MYOB derives income accounts from the Item):
//         B2B_SALES         product/goods income lines
//         B2B_FREIGHT       freight income line
//         B2B_CARD_FEE      card-surcharge line (and partial-refund credits)
//         UNDEPOSITED_FUNDS the account customer payments deposit to
//     A missing mapping on a GL-hitting document is an HONEST REFUSAL —
//     a thrown Error reading 'xero account mapping missing: <KEY> (JAWS)'
//     (the callers' existing catch-and-log handling surfaces it). DRAFT
//     invoices tolerate missing codes (Xero allows account-less draft
//     lines; they must be mapped before authorising).
//   • The b2b_orders myob_* columns are reused to hold the Xero ids
//     (InvoiceID / PaymentID) when the provider is 'xero' — the
//     ACCOUNTING_PROVIDER setting records which provider minted them
//     (types.ts convention). Mixed-provider history (order written under
//     MYOB, then the switch flips) is NOT reconciled here — the Xero path
//     will simply not find the MYOB UID and fail honestly.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { accountingProvider } from '../accounting-provider'
import { XeroAdapter, NeutralLine } from './xero-adapter'
import * as myobInvoice from '../b2b-myob-invoice'
import * as myobPo from '../b2b-myob-po'
import type { MyobWriteResult, MyobConvertResult, MyobPaymentResult, MyobCreditNoteResult } from '../b2b-myob-invoice'
import type { CreatePOInput, CreatePOResult, DropShipPOLine, ConvertPoToBillInput, ConvertPoToBillResult } from '../b2b-myob-po'

// Callers import these shapes from here after the swap.
export type { MyobWriteResult, MyobConvertResult, MyobPaymentResult, MyobCreditNoteResult }
export type { CreatePOInput, CreatePOResult, DropShipPOLine, ConvertPoToBillInput, ConvertPoToBillResult }

const ENTITY = 'JAWS' as const
const MODULE = 'B2B'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

function round2(n: number): number { return Math.round(n * 100) / 100 }

async function isXero(): Promise<boolean> {
  return (await accountingProvider(ENTITY, MODULE)) === 'xero'
}

function xero(): XeroAdapter {
  return new XeroAdapter(ENTITY)
}

// ── Xero mapping helpers ─────────────────────────────────────────────────

// Sentinel keys in xero_account_map (see file header). Cached per process.
const _accountCodeCache = new Map<string, string>()

async function mappedAccountCode(key: string): Promise<string> {
  const cacheKey = `${ENTITY}:${key}`
  const hit = _accountCodeCache.get(cacheKey)
  if (hit) return hit
  const { data, error } = await sb().from('xero_account_map')
    .select('xero_account_code').eq('entity', ENTITY).eq('myob_display_id', key).maybeSingle()
  if (error) throw new Error(`xero_account_map lookup failed for ${key}: ${error.message}`)
  const code = (data?.xero_account_code || '').trim()
  if (!code) {
    throw new Error(`xero account mapping missing: ${key} (${ENTITY}) — seed xero_account_map (entity='${ENTITY}', myob_display_id='${key}') with the Xero account code`)
  }
  _accountCodeCache.set(cacheKey, code)
  return code
}

// Same lookup, but tolerated-missing (DRAFT invoices may omit account codes).
async function mappedAccountCodeOrNull(key: string): Promise<string | undefined> {
  try { return await mappedAccountCode(key) } catch { return undefined }
}

interface DistLite {
  id: string
  display_name: string | null
  myob_primary_customer_uid: string | null
  xero_contact_id: string | null
}

/**
 * Resolve the distributor's Xero ContactID:
 *   1. b2b_distributors.xero_contact_id (direct link)
 *   2. xero_contact_map by the distributor's MYOB customer UID
 *   3. adapter.findContact by display name
 *   4. adapter.createContact (name only — richer card fields can be filled
 *      in Xero; the adapter's create takes name/abn/email and we only hold
 *      the display name here)
 * Steps 2–4 persist the id back to BOTH b2b_distributors.xero_contact_id
 * and xero_contact_map so repeat orders resolve in one read.
 */
async function resolveDistributorXeroContact(dist: DistLite): Promise<string> {
  const c = sb()
  if (dist.xero_contact_id) return dist.xero_contact_id

  const persist = async (contactId: string, contactName: string | null) => {
    try {
      await c.from('b2b_distributors').update({ xero_contact_id: contactId }).eq('id', dist.id)
    } catch (e: any) { console.error('post-b2b-doc: persisting b2b_distributors.xero_contact_id failed:', e?.message || e) }
    if (dist.myob_primary_customer_uid) {
      try {
        await c.from('xero_contact_map').upsert({
          entity: ENTITY,
          myob_uid: dist.myob_primary_customer_uid,
          xero_contact_id: contactId,
          contact_name: contactName || dist.display_name || null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'entity,myob_uid' })
      } catch (e: any) { console.error('post-b2b-doc: persisting xero_contact_map failed:', e?.message || e) }
    }
  }

  // 2. xero_contact_map via the MYOB customer UID
  if (dist.myob_primary_customer_uid) {
    const { data } = await c.from('xero_contact_map')
      .select('xero_contact_id')
      .eq('entity', ENTITY).eq('myob_uid', dist.myob_primary_customer_uid).maybeSingle()
    const mapped = (data?.xero_contact_id || '').trim()
    if (mapped) {
      await persist(mapped, dist.display_name)
      return mapped
    }
  }

  const name = (dist.display_name || '').trim()
  if (!name) throw new Error(`Distributor ${dist.id} has no xero_contact_id, no mapped MYOB UID and no display name — cannot resolve a Xero contact`)

  // 3. Find by name
  const adapter = xero()
  const found = await adapter.findContact({ kind: 'customer', name })
  if (found) {
    await persist(found.id, found.name)
    return found.id
  }

  // 4. Create
  const created = await adapter.createContact({ kind: 'customer', name })
  await persist(created.id, created.name)
  return created.id
}

interface B2bLineRow {
  id: string
  myob_item_uid: string | null
  sku: string | null
  name: string | null
  qty: number
  line_subtotal_ex_gst: number | null
  line_gst: number | null
  line_total_inc: number | null
  is_taxable: boolean | null
}

// GST-inclusive line total (falls back to ex + gst when the inc column is null).
function lineIncTotal(ln: B2bLineRow): number {
  if (ln.line_total_inc != null) return round2(Number(ln.line_total_inc))
  return round2(Number(ln.line_subtotal_ex_gst || 0) + Number(ln.line_gst || 0))
}

// Product line description — qty is folded in because the adapter posts
// Quantity 1 / UnitAmount = line total (no per-unit pricing yet). MYOB item
// UIDs have no Xero item mapping, so these are description-only lines.
function lineDescription(ln: B2bLineRow, prefix = ''): string {
  const base = `${prefix}${ln.name || ''} — ${ln.sku || ''}`.trim()
  const qty = Number(ln.qty || 1)
  return (qty !== 1 ? `${base} × ${qty}` : base).substring(0, 255)
}

// ── writeOrderToMyob ─────────────────────────────────────────────────────

/**
 * Writes a paid B2B order to the accounting provider.
 *   myob → Sale.Order (lib/b2b-myob-invoice.writeOrderToMyob, unchanged)
 *   xero → ACCREC invoice with status DRAFT. Xero has no Sale Order entity;
 *          a DRAFT invoice is the closest equivalent (no GL impact until
 *          authorised). Freight becomes a GST-inclusive line item; the
 *          portal-controlled MYOB number stream is NOT used (the adapter
 *          cannot set an ACCREC InvoiceNumber — Xero auto-numbers).
 */
export async function writeOrderToMyob(orderId: string): Promise<MyobWriteResult> {
  if (!(await isXero())) return myobInvoice.writeOrderToMyob(orderId)

  const c = sb()
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select(`
      id, order_number, status,
      subtotal_ex_gst, gst, card_fee_inc, total_inc,
      freight_cost_ex_gst, customer_po,
      myob_invoice_uid, myob_invoice_number, myob_write_attempts,
      stripe_payment_intent_id,
      distributor:b2b_distributors!b2b_orders_distributor_id_fkey (
        id, display_name, myob_primary_customer_uid, xero_contact_id
      )
    `)
    .eq('id', orderId).maybeSingle()
  if (oErr) throw new Error(`Order load failed: ${oErr.message}`)
  if (!order) throw new Error(`Order ${orderId} not found`)

  // Idempotency — same guard column as the MYOB path.
  if (order.myob_invoice_uid) {
    return { myob_invoice_uid: order.myob_invoice_uid, myob_invoice_number: order.myob_invoice_number, status: 'already_written' }
  }
  if (order.status !== 'paid') {
    throw new Error(`Order ${orderId} is not paid (status=${order.status}); refusing to write to Xero`)
  }

  const dist: any = Array.isArray(order.distributor) ? order.distributor[0] : order.distributor
  if (!dist) throw new Error(`Order ${orderId} has no distributor`)

  const { data: lines, error: lErr } = await c
    .from('b2b_order_lines')
    .select('id, myob_item_uid, sku, name, qty, line_subtotal_ex_gst, line_gst, line_total_inc, is_taxable, sort_order')
    .eq('order_id', orderId).order('sort_order', { ascending: true })
  if (lErr) throw new Error(`Order lines load failed: ${lErr.message}`)
  if (!lines || lines.length === 0) throw new Error(`Order ${orderId} has no lines`)

  const contactId = await resolveDistributorXeroContact(dist)

  // DRAFT tolerates missing account codes — attach them when mapped so the
  // draft is authorise-ready, omit when the mapping isn't seeded yet.
  const salesCode = await mappedAccountCodeOrNull('B2B_SALES')
  const feeCode = await mappedAccountCodeOrNull('B2B_CARD_FEE')
  const freightCode = await mappedAccountCodeOrNull('B2B_FREIGHT')

  const xeroLines: NeutralLine[] = (lines as B2bLineRow[]).map(ln => ({
    description: lineDescription(ln),
    amount: lineIncTotal(ln),
    accountCode: salesCode,
    taxType: ln.is_taxable !== false ? 'GST' : 'FRE',
  }))

  const cardFeeInc = round2(Number(order.card_fee_inc || 0))
  if (cardFeeInc > 0) {
    xeroLines.push({ description: 'Card processing surcharge', amount: cardFeeInc, accountCode: feeCode, taxType: 'FRE' })
  }

  // MYOB models freight as a header field; Xero doesn't — freight is its own
  // GST-inclusive line item (freight is GST-taxable in the portal).
  const freightExGst = round2(Number(order.freight_cost_ex_gst || 0))
  if (freightExGst > 0) {
    xeroLines.push({ description: 'Freight', amount: round2(freightExGst * 1.1), accountCode: freightCode, taxType: 'GST' })
  }

  // Attempt counter before the call — same audit convention as the MYOB path.
  await c.from('b2b_orders')
    .update({ myob_write_attempts: (order.myob_write_attempts || 0) + 1 })
    .eq('id', orderId)

  let created: { id: string; number: string }
  try {
    created = await xero().createInvoice({
      contactId,
      lines: xeroLines,
      reference: (order.customer_po || '').trim() || String(order.order_number || ''),
      status: 'draft',   // Xero's stand-in for MYOB Sale.Order — no GL impact
      dateIso: new Date().toISOString(),
    })
  } catch (e: any) {
    const errMsg = `Xero draft invoice POST failed: ${e?.message || e}`
    await c.from('b2b_orders').update({ myob_write_error: errMsg.substring(0, 1000) }).eq('id', orderId)
    throw new Error(errMsg)
  }

  await c.from('b2b_orders').update({
    myob_invoice_uid: created.id,           // holds the Xero InvoiceID under provider 'xero'
    myob_invoice_number: created.number || null,
    myob_written_at: new Date().toISOString(),
    myob_write_error: null,
  }).eq('id', orderId)

  return { myob_invoice_uid: created.id, myob_invoice_number: created.number || null, status: 'created' }
}

// ── convertOrderToInvoiceInMyob ──────────────────────────────────────────

/**
 * Converts the pending order document into a GL invoice on shipment.
 *   myob → native Sale.Order → Sale.Invoice conversion (unchanged)
 *   xero → NOT YET SUPPORTED: 'conversion' on Xero means authorising the
 *          draft ACCREC invoice, but the XeroAdapter exposes no
 *          authorise-a-draft operation yet (adapter gap). This throws a
 *          clear error; the callers already treat conversion as best-effort
 *          and log the failure without blocking freight booking.
 */
export async function convertOrderToInvoiceInMyob(
  orderId: string,
  opts: { trackingNumber?: string | null; carrier?: string | null } = {},
): Promise<MyobConvertResult> {
  if (!(await isXero())) return myobInvoice.convertOrderToInvoiceInMyob(orderId, opts)

  const c = sb()
  const { data: order } = await c.from('b2b_orders')
    .select('myob_invoice_uid, myob_sale_invoice_uid, myob_sale_invoice_number')
    .eq('id', orderId).maybeSingle()
  if (order?.myob_sale_invoice_uid) {
    return { myob_sale_invoice_uid: order.myob_sale_invoice_uid, myob_sale_invoice_number: order.myob_sale_invoice_number, status: 'already_converted' }
  }
  throw new Error(
    `xero: order→invoice conversion not yet supported — Xero has no order entity and the Xero adapter has no ` +
    `authorise-a-draft operation. Authorise the draft invoice${order?.myob_invoice_uid ? ` ${order.myob_invoice_uid}` : ''} in Xero manually.`,
  )
}

// ── applyCustomerPaymentInMyob ───────────────────────────────────────────

/**
 * Receipts the Stripe payment against the order's GL invoice.
 *   myob → CustomerPayment → Undeposited Funds (unchanged)
 *   xero → Payment against the ACCREC invoice, deposited to the account
 *          mapped under xero_account_map key UNDEPOSITED_FUNDS (honest
 *          refusal when unmapped). Differences from MYOB, noted honestly:
 *          - Xero can only pay AUTHORISED invoices, and conversion is not
 *            yet supported on Xero — so in practice this stays at
 *            'no_invoice' until conversion lands (same gate column).
 *          - The MYOB path reads the invoice's live balance and never
 *            overpays; the adapter has no per-invoice read, so this applies
 *            order.total_inc and relies on Xero rejecting an overpayment.
 */
export async function applyCustomerPaymentInMyob(orderId: string): Promise<MyobPaymentResult> {
  if (!(await isXero())) return myobInvoice.applyCustomerPaymentInMyob(orderId)

  const c = sb()
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select('id, order_number, total_inc, paid_at, payment_settled_at, payment_method, stripe_payment_intent_id, myob_sale_invoice_uid, myob_payment_uid')
    .eq('id', orderId).maybeSingle()
  if (oErr) throw new Error(`Order load failed: ${oErr.message}`)
  if (!order) throw new Error(`Order ${orderId} not found`)

  if (order.myob_payment_uid) return { myob_payment_uid: order.myob_payment_uid, status: 'already_applied' }
  if (!order.myob_sale_invoice_uid) return { myob_payment_uid: null, status: 'no_invoice' }
  if (!order.payment_settled_at) return { myob_payment_uid: null, status: 'not_settled' }

  const accountCode = await mappedAccountCode('UNDEPOSITED_FUNDS')
  const amount = round2(Number(order.total_inc || 0))
  if (!(amount > 0)) throw new Error(`Order ${orderId} has no positive total to receipt`)

  const payDate = String(order.payment_settled_at || order.paid_at || new Date().toISOString()).substring(0, 10)
  const pay = await xero().applyPayment({
    invoiceId: order.myob_sale_invoice_uid,
    amount,
    dateIso: payDate,
    accountCode,
  })

  await c.from('b2b_orders').update({
    myob_payment_uid: pay.id,               // holds the Xero PaymentID under provider 'xero'
    myob_payment_at: new Date().toISOString(),
  }).eq('id', orderId)

  return { myob_payment_uid: pay.id, status: 'created' }
}

// ── deleteMyobSaleOrder ──────────────────────────────────────────────────

/**
 * Removes the pre-shipment order document after a full refund.
 *   myob → DELETE the Sale.Order (unchanged)
 *   xero → the 'order' is a DRAFT ACCREC invoice; voidDocument deletes
 *          drafts (Xero rule: drafts are DELETED, authorised docs VOIDED).
 */
export async function deleteMyobSaleOrder(orderId: string): Promise<{ deleted: boolean; reason?: string }> {
  if (!(await isXero())) return myobInvoice.deleteMyobSaleOrder(orderId)

  const c = sb()
  const { data: order } = await c.from('b2b_orders')
    .select('myob_invoice_uid, myob_sale_invoice_uid').eq('id', orderId).maybeSingle()
  if (!order?.myob_invoice_uid) return { deleted: false, reason: 'no accounting order document on file' }
  if (order.myob_sale_invoice_uid) return { deleted: false, reason: 'order already converted to an invoice — credit note path applies' }

  try {
    await xero().voidDocument('invoice', order.myob_invoice_uid)
  } catch (e: any) {
    const msg = String(e?.message || e)
    if (/not found/i.test(msg)) return { deleted: false, reason: 'Xero draft invoice not found (already deleted?)' }
    throw e
  }
  return { deleted: true }
}

// ── writeRefundCreditNoteToMyob ──────────────────────────────────────────

/**
 * Mirrors a Stripe refund as a credit note.
 *   myob → negative Sale.Invoice (unchanged)
 *   xero → native ACCRECCREDIT credit note (AUTHORISED — it must hit the
 *          GL like the MYOB one does), so every line REQUIRES a mapped
 *          account code (honest refusal when unmapped):
 *          - full mirror: product lines (description-only — no item
 *            mapping) on B2B_SALES, surcharge on B2B_CARD_FEE (FRE),
 *            freight as its own line on B2B_FREIGHT (GST) — Xero has no
 *            header freight field.
 *          - partial: single FRE line on B2B_CARD_FEE, matching the MYOB
 *            partial's bank-fees-item treatment.
 *          Numbering comes from Xero's own credit-note sequence — the
 *          portal-controlled "CR" stream is a MYOB-only concept.
 */
export async function writeRefundCreditNoteToMyob(
  orderId: string,
  refundAmount: number,
  meta: { stripeRefundId?: string; reason?: string } = {},
): Promise<MyobCreditNoteResult> {
  if (!(await isXero())) return myobInvoice.writeRefundCreditNoteToMyob(orderId, refundAmount, meta)

  const c = sb()
  const { data: order, error: oErr } = await c
    .from('b2b_orders')
    .select(`
      id, order_number, total_inc, refunded_total, card_fee_inc, freight_cost_ex_gst,
      stripe_payment_intent_id,
      distributor:b2b_distributors!b2b_orders_distributor_id_fkey (
        id, display_name, myob_primary_customer_uid, xero_contact_id
      )
    `)
    .eq('id', orderId).maybeSingle()
  if (oErr) throw new Error(`Order load failed: ${oErr.message}`)
  if (!order) throw new Error(`Order ${orderId} not found`)

  const dist: any = Array.isArray(order.distributor) ? order.distributor[0] : order.distributor
  if (!dist) throw new Error(`Order ${orderId} has no distributor`)

  const { data: lines, error: lErr } = await c
    .from('b2b_order_lines')
    .select('id, myob_item_uid, sku, name, qty, line_subtotal_ex_gst, line_gst, line_total_inc, is_taxable, sort_order')
    .eq('order_id', orderId).order('sort_order', { ascending: true })
  if (lErr) throw new Error(`Order lines load failed: ${lErr.message}`)
  if (!lines || lines.length === 0) throw new Error(`Order ${orderId} has no lines`)

  const contactId = await resolveDistributorXeroContact(dist)

  const totalInc = round2(Number(order.total_inc || 0))
  const cardFeeInc = round2(Number(order.card_fee_inc || 0))
  const priorRefunded = round2(Number(order.refunded_total || 0)) - round2(refundAmount)
  const isFullMirror = Math.abs(refundAmount - totalInc) < 0.005 && Math.abs(priorRefunded) < 0.005

  const xeroLines: NeutralLine[] = []
  if (isFullMirror) {
    const salesCode = await mappedAccountCode('B2B_SALES')
    for (const ln of lines as B2bLineRow[]) {
      xeroLines.push({
        description: lineDescription(ln, 'Refund: '),
        amount: lineIncTotal(ln),            // POSITIVE — Xero credit notes take positive lines
        accountCode: salesCode,
        taxType: ln.is_taxable !== false ? 'GST' : 'FRE',
      })
    }
    if (cardFeeInc > 0) {
      xeroLines.push({
        description: 'Card processing surcharge — refund',
        amount: cardFeeInc,
        accountCode: await mappedAccountCode('B2B_CARD_FEE'),
        taxType: 'FRE',
      })
    }
    const freightExGst = round2(Number(order.freight_cost_ex_gst || 0))
    if (freightExGst > 0) {
      // Freight line item (Xero has no header freight field), GST-inclusive.
      xeroLines.push({
        description: 'Freight — refund',
        amount: round2(freightExGst * 1.1),
        accountCode: await mappedAccountCode('B2B_FREIGHT'),
        taxType: 'GST',
      })
    }
  } else {
    // Partial / additional refund: single line, no GST — matching the MYOB
    // partial's approximate tax treatment (staff refine the split if needed).
    xeroLines.push({
      description: `Refund — Order ${order.order_number}`.substring(0, 255),
      amount: round2(refundAmount),
      accountCode: await mappedAccountCode('B2B_CARD_FEE'),
      taxType: 'FRE',
    })
  }

  const cn = await xero().createCreditNote({
    contactId,
    kind: 'sale',
    lines: xeroLines,
    reference: `Refund — Order ${order.order_number}${meta.stripeRefundId ? ` — Stripe ${meta.stripeRefundId}` : ''}`.substring(0, 255),
    dateIso: new Date().toISOString(),
    // status omitted → adapter posts AUTHORISED (hits the GL, like MYOB)
  })

  return {
    credit_note_uid: cn.id,
    credit_note_number: cn.number || cn.id,  // Xero auto-numbers; id as last resort
    amount: round2(refundAmount),
    shape: isFullMirror ? 'mirror_full' : 'single_line',
  }
}

// ── getMyobInvoicePdf ────────────────────────────────────────────────────

/**
 * Fetches the provider-rendered tax-invoice PDF for an order.
 *   myob → MYOB's rendered PDF (unchanged)
 *   xero → NOT YET SUPPORTED (adapter gap — no PDF fetch operation).
 *          Returns null, never throws — exactly the contract callers rely
 *          on: they fall back to the system-generated PDF.
 */
export async function getMyobInvoicePdf(orderId: string): Promise<{ buffer: Buffer; filename: string } | null> {
  if (!(await isXero())) return myobInvoice.getMyobInvoicePdf(orderId)
  console.warn(`post-b2b-doc: Xero invoice PDF fetch not yet supported (order ${orderId}) — falling back to the system PDF`)
  return null
}

// ── createDropShipPurchaseOrder ──────────────────────────────────────────

/**
 * Raises a drop-ship supplier Purchase Order.
 *   myob → Purchase/Order/Item in JAWS (unchanged)
 *   xero → NOT YET SUPPORTED: the XeroAdapter has no purchase-order
 *          operation (Xero does have a PO API — adapter gap). The caller
 *          (lib/b2b-dropship.ts) records this as a per-supplier failure and
 *          the order proceeds; raise the PO in Xero manually.
 */
export async function createDropShipPurchaseOrder(input: CreatePOInput): Promise<CreatePOResult> {
  if (!(await isXero())) return myobPo.createDropShipPurchaseOrder(input)
  throw new Error(
    'xero: drop-ship purchase orders not yet supported — the Xero adapter has no purchase-order operation. ' +
    'Raise the PO in Xero manually (drop-ship, ship-to the customer address).',
  )
}

// ── convertDropShipPoToBill ──────────────────────────────────────────────

/**
 * Converts a drop-ship supplier Purchase ORDER into a BILL when the supplier
 * confirms (receives the stock into the supplier's DS location so the sale
 * order can convert to an invoice).
 *   myob → native Purchase.Order → Purchase.Bill conversion via the
 *          Order:{UID} link (unchanged mirror of the sale side)
 *   xero → NOT YET SUPPORTED: the XeroAdapter has no purchase-order
 *          operation (same gap as createDropShipPurchaseOrder). Bill the PO
 *          in Xero manually.
 */
export async function convertDropShipPoToBill(input: ConvertPoToBillInput): Promise<ConvertPoToBillResult> {
  if (!(await isXero())) return myobPo.convertDropShipPoToBill(input)
  throw new Error(
    'xero: drop-ship PO→bill conversion not yet supported — the Xero adapter has no purchase-order operation. ' +
    'Bill the purchase order in Xero manually, then retry the invoice conversion.',
  )
}

// ── getSupplierContact ───────────────────────────────────────────────────

/**
 * Reads a supplier's email + name off their card (for PO emailing).
 *   myob → Contact/Supplier read (unchanged)
 *   xero → NOT YET SUPPORTED: callers pass a MYOB supplier UID (from
 *          b2b_catalogue.myob_supplier_uid) and the XeroAdapter's contact
 *          shape does not expose email addresses (adapter gap). Returning
 *          email:null would be dishonest ('supplier has no email'), so this
 *          throws a clear error instead — the PO-email flows surface it as
 *          a failed email, which is the truth.
 */
export async function getSupplierContact(supplierUid: string): Promise<{ email: string | null; name: string | null }> {
  if (!(await isXero())) return myobPo.getSupplierContact(supplierUid)
  throw new Error(
    `xero: supplier email lookup not yet supported — ${supplierUid} is a MYOB supplier UID and the Xero adapter ` +
    'does not expose contact email addresses. Email the supplier PO manually.',
  )
}
