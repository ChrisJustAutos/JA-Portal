// lib/accounting/post-workshop-doc.ts
//
// The WORKSHOP invoicing seam for the MYOB → Xero migration.
//
// Thin provider-switching wrappers over the workshop accounting writes. Each
// consults accountingProvider('VPS', 'WORKSHOP') (THE SWITCH,
// lib/accounting-provider.ts — defaults to 'myob', so shipping this changes
// nothing until the settings key flips):
//
//   'myob' → delegate STRAIGHT THROUGH to the battle-tested lib functions
//            (lib/workshop-myob-invoice.ts / lib/workshop-credit-note.ts) —
//            byte-for-byte identical behaviour.
//   'xero' → the same local orchestration (guards, DB rows, stock ledger,
//            activity log, letters) with the remote leg translated through
//            XeroAdapter (lib/accounting/xero-adapter.ts).
//
// Xero translation decisions (honest, none silent):
//   • Contacts resolve via xero_contact_map (entity + MYOB customer UID →
//     Xero ContactID); on a miss we findContact by name, else createContact,
//     and upsert the mapping. Customers with no myob_uid resolve by name each
//     time (the map is keyed by MYOB UID; workshop_customers has no
//     xero_contact_id column).
//   • Account codes: workshop_settings stores MYOB account UIDs. UID →
//     DisplayID via a read-only fetch of the MYOB chart (MYOB stays connected
//     read-only during the migration), then DisplayID → Xero code via
//     xero_account_map. An unmapped account is a CLEAR failure in the
//     caller's own error shape ("Xero account mapping missing: X") — never a
//     guessed code.
//   • MYOB Sale ORDER (no GL impact) → Xero DRAFT invoice (also no GL
//     impact); Sale Invoice → AUTHORISED. Payments stay blocked while
//     invoice_as_order is on — Xero drafts can't take payments either.
//   • MYOB Item lines (stock decrement + COGS) have no adapter equivalent —
//     everything posts as account lines; portal stock is still deducted via
//     the shared deductJobStock ledger. Surfaced in provider_warning.
//   • MYOB Categories (tracking_category_uid) are skipped with a warning —
//     Xero tracking categories aren't wired through the adapter.
//   • MYOB Comment/JournalMemo have no adapter field — noted in
//     provider_warning when a description would have been carried.
//   • MYOB Header (description) rows → $0 Xero lines (Xero has no header
//     rows).
//   • The MYOB Sale/CreditRefund leg (cash back against a credit) is not
//     wired for Xero — the refund records locally and the warning tells
//     staff to settle it in Xero.
//   • The workshop_bookings.myob_invoice_uid / workshop_payments
//     .myob_payment_uid / workshop_credit_notes.myob_credit_uid columns hold
//     the XERO ids while the module is on Xero (both are opaque guids; the
//     provider switch is recorded in integration_settings). Idempotency,
//     un-finalise and payments all key off the same column either way.
//
// NOTE: this file binds to the CONCRETE XeroAdapter (not the
// getAccountingAdapter factory) because lib/accounting/types.ts and the
// adapter's locally-declared contract haven't been reconciled yet
// (findContact/createContact signatures + applyPayment result shape differ).
// Once the seam is reconciled this can move to the factory.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { accountingProvider } from '../accounting-provider'
import { XeroAdapter, NeutralLine } from './xero-adapter'
import { getConnection, myobFetch } from '../myob'
import { WORKSHOP_MYOB_LABEL, PaymentTender } from '../workshop'
import { logWorkshopActivity } from '../workshop-activity'
import { maybeAutoLetterForBooking } from '../workshop-letters'
import {
  createJobInvoiceInMyob,
  unfinaliseJob,
  recordJobPayment,
  getWorkshopSettings,
  deductJobStock,
  WorkshopInvoiceError,
  WorkshopPaymentError,
  JobInvoiceResult,
  UnfinaliseResult,
  JobPaymentResult,
} from '../workshop-myob-invoice'
import {
  createCreditNote as createCreditNoteInMyob,
  WorkshopCreditNoteError,
  CreateCreditNoteInput as WorkshopCreditNoteInput,
  CreditNoteResult,
} from '../workshop-credit-note'

const ENTITY = 'VPS' as const
const MODULE = 'WORKSHOP'

const round2 = (n: number) => Math.round(n * 100) / 100
const money = (n: number) => `$${round2(n).toFixed(2)}`

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

// ── Mapping helpers (Xero path only) ─────────────────────────────────────

// Workshop settings store MYOB account UIDs; xero_account_map is keyed by
// MYOB DisplayID. Resolve UID → DisplayID off the MYOB chart (read-only —
// MYOB stays connected for history during the migration), cached 10 min.
let _uidToDisplay: { at: number; map: Map<string, string> } | null = null
async function myobAccountDisplayId(uid: string): Promise<string | null> {
  const now = Date.now()
  if (!_uidToDisplay || now - _uidToDisplay.at > 10 * 60_000) {
    const conn = await getConnection(WORKSHOP_MYOB_LABEL)
    if (!conn || !conn.company_file_id) {
      throw new Error(`${WORKSHOP_MYOB_LABEL} MYOB connection not configured — the Xero account map is keyed by MYOB DisplayID and needs a read-only look at the MYOB chart to resolve the configured account UIDs`)
    }
    const r = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/GeneralLedger/Account`, { query: { '$top': 1000 } })
    if (r.status !== 200) throw new Error(`MYOB Account fetch failed (HTTP ${r.status}) while resolving the Xero account map`)
    const map = new Map<string, string>()
    for (const a of (Array.isArray(r.data?.Items) ? r.data.Items : []) as any[]) {
      if (a?.UID && a?.DisplayID) map.set(String(a.UID), String(a.DisplayID))
    }
    _uidToDisplay = { at: now, map }
  }
  return _uidToDisplay.map.get(uid) || null
}

type AccountCodeLookup = { ok: true; code: string } | { ok: false; missing: string }

async function xeroAccountCodeForMyobUid(uid: string): Promise<AccountCodeLookup> {
  const displayId = await myobAccountDisplayId(uid)
  if (!displayId) return { ok: false, missing: `MYOB account UID ${uid} (not found in the ${WORKSHOP_MYOB_LABEL} chart)` }
  const { data } = await sb()
    .from('xero_account_map')
    .select('xero_account_code')
    .eq('entity', ENTITY)
    .eq('myob_display_id', displayId)
    .maybeSingle()
  if (!data?.xero_account_code) return { ok: false, missing: displayId }
  return { ok: true, code: String(data.xero_account_code) }
}

const mappingMissing = (missing: string) =>
  `Xero account mapping missing: ${missing} — add it to xero_account_map (entity ${ENTITY}) before posting workshop documents to Xero.`

// Contact: xero_contact_map first (keyed by MYOB customer UID), else
// findContact by name, else createContact — then persist the mapping so
// re-posts hit the same Xero contact.
async function resolveXeroContactId(
  adapter: XeroAdapter,
  cust: { myob_uid?: string | null; name?: string | null; email?: string | null },
): Promise<string> {
  if (cust.myob_uid) {
    const { data } = await sb()
      .from('xero_contact_map')
      .select('xero_contact_id')
      .eq('entity', ENTITY)
      .eq('myob_uid', cust.myob_uid)
      .maybeSingle()
    if (data?.xero_contact_id) return String(data.xero_contact_id)
  }
  const name = String(cust.name || '').trim()
  if (!name) throw new Error('Customer has no name — cannot resolve a Xero contact')
  let contact = await adapter.findContact({ kind: 'customer', name })
  if (!contact) {
    contact = await adapter.createContact({ kind: 'customer', name, email: cust.email || undefined })
  }
  if (cust.myob_uid) {
    await sb().from('xero_contact_map').upsert({
      entity: ENTITY,
      myob_uid: cust.myob_uid,
      xero_contact_id: contact.id,
      contact_name: contact.name || name,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'entity,myob_uid' })
  }
  return contact.id
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Push job invoice
// ═══════════════════════════════════════════════════════════════════════

/** JobInvoiceResult plus honest notes about what the Xero translation
 *  skipped (tracking category, item/stock lines, comment). Always absent/null
 *  on the MYOB path. */
export type WorkshopInvoiceResult = JobInvoiceResult & { provider_warning?: string | null }

export async function pushWorkshopInvoice(bookingId: string, performedBy: string | null = null): Promise<WorkshopInvoiceResult> {
  if ((await accountingProvider(ENTITY, MODULE)) === 'myob') {
    return createJobInvoiceInMyob(bookingId, performedBy)
  }
  return pushWorkshopInvoiceXero(bookingId, performedBy)
}

// Mirrors lib/workshop-myob-invoice.ts::createJobInvoiceInMyob step for step
// (same guards, same local rows, same totals math) with the remote POST
// translated to XeroAdapter.createInvoice. Keep the two in sync.
async function pushWorkshopInvoiceXero(bookingId: string, performedBy: string | null): Promise<WorkshopInvoiceResult> {
  const c = sb()

  const { data: booking, error: bErr } = await c
    .from('workshop_bookings')
    .select('id, status, customer_id, description, myob_invoice_uid, order_number, third_party_customer_id, customer:workshop_customers!customer_id(id, name, email, myob_uid)')
    .eq('id', bookingId)
    .maybeSingle()
  if (bErr) throw new Error(`Job load failed: ${bErr.message}`)
  if (!booking) throw new Error('Job not found')

  const settings = await getWorkshopSettings()
  const mode: 'order' | 'invoice' = settings.invoice_as_order ? 'order' : 'invoice'

  // Idempotency — under Xero mode this column holds the Xero InvoiceID.
  if (booking.myob_invoice_uid) {
    return { myob_uid: booking.myob_invoice_uid, myob_number: null, mode, status: 'already_written' }
  }

  // Master gate — same switch as the MYOB path.
  if (!settings.myob_posting_enabled) {
    throw new WorkshopInvoiceError('posting_disabled', 'Accounting posting is turned off. Turn it on in Workshop Settings → MYOB accounts once MechanicDesk is retired.')
  }

  const cust: any = Array.isArray(booking.customer) ? booking.customer[0] : booking.customer
  if (!cust?.name) {
    throw new WorkshopInvoiceError('customer_not_synced', 'This job has no customer (or the customer has no name) — pick a customer before invoicing.')
  }
  if (!settings.myob_sales_account_uid) {
    throw new WorkshopInvoiceError('sales_account_not_set', 'No workshop sales account configured. An admin must pick the income account workshop sales post to.')
  }

  const { data: lines } = await c.from('workshop_booking_lines')
    .select('*')
    .eq('booking_id', bookingId)
    .order('sort_order', { ascending: true })
  if (!lines || lines.length === 0) throw new WorkshopInvoiceError('no_lines', 'Add at least one line item before invoicing.')

  // Account codes — never guessed.
  const salesCode = await xeroAccountCodeForMyobUid(settings.myob_sales_account_uid)
  if (!salesCode.ok) throw new WorkshopInvoiceError('sales_account_not_set', mappingMissing(salesCode.missing))
  let partCode = salesCode.code
  if (settings.part_sale_account_uid) {
    const pc = await xeroAccountCodeForMyobUid(settings.part_sale_account_uid)
    if (!pc.ok) throw new WorkshopInvoiceError('sales_account_not_set', mappingMissing(pc.missing))
    partCode = pc.code
  }

  const adapter = new XeroAdapter(ENTITY)
  let contactId: string
  try {
    contactId = await resolveXeroContactId(adapter, cust)
  } catch (e: any) {
    throw new WorkshopInvoiceError('customer_not_synced', `Couldn’t resolve the customer in Xero: ${e?.message || e}`)
  }

  // Build lines — identical subtotal/tax math to the MYOB path so the local
  // workshop_invoices row is byte-for-byte the same; amounts sent to the
  // adapter are GST-INCLUSIVE (its convention).
  const xeroLines: NeutralLine[] = []
  let subtotal = 0, totalTax = 0, txnCount = 0
  for (const ln of lines as any[]) {
    if (ln.line_type === 'description') {
      // MYOB Header row → $0 Xero line (Xero has no header rows).
      if (ln.description) xeroLines.push({ description: String(ln.description).substring(0, 255), amount: 0, accountCode: salesCode.code, taxType: 'FRE' })
      continue
    }
    const lineEx = round2((Number(ln.total_ex_gst) || 0) || (Number(ln.qty) * Number(ln.unit_price_ex_gst)))
    if (lineEx === 0 && !ln.description) continue
    const rate = Number(ln.gst_rate) || 0
    const taxable = rate > 0
    const desc = `${ln.description || ln.part_number || ln.line_type}${ln.part_number ? ` (${ln.part_number})` : ''}`.substring(0, 255)
    xeroLines.push({
      description: desc,
      amount: round2(lineEx * (1 + rate)),
      accountCode: ln.line_type === 'part' ? partCode : salesCode.code,
      taxType: taxable ? 'GST' : 'FRE',
    })
    txnCount++
    subtotal += lineEx
    if (taxable) totalTax += lineEx * rate
  }
  subtotal = round2(subtotal); totalTax = round2(totalTax)
  const totalAmount = round2(subtotal + totalTax)
  if (txnCount === 0) throw new WorkshopInvoiceError('no_lines', 'No billable lines to invoice.')

  // Honest notes about what the translation can't carry.
  const warnings: string[] = []
  if (settings.labour_item_uid) {
    warnings.push('Posted as Xero account lines — item lines / Xero stock decrement aren’t wired through the adapter (portal stock is still deducted).')
  }
  if (settings.tracking_category_uid) {
    warnings.push(`MYOB tracking category "${settings.tracking_category_name || settings.tracking_category_uid}" skipped — Xero tracking categories aren’t wired through the adapter.`)
  }
  if ((booking as any).description) {
    warnings.push('The work-done description (MYOB invoice Comment) has no adapter field and was not carried onto the Xero invoice.')
  }

  const today = new Date().toISOString().substring(0, 10)
  let created: { id: string; number: string }
  try {
    created = await adapter.createInvoice({
      contactId,
      lines: xeroLines,
      reference: (booking as any).order_number ? String((booking as any).order_number).substring(0, 255) : undefined,
      // MYOB Sale Order (no GL impact) → Xero DRAFT invoice.
      status: mode === 'order' ? 'draft' : 'authorised',
      dateIso: today,
    })
  } catch (e: any) {
    throw new WorkshopInvoiceError('myob_error', `Xero invoice POST failed: ${e?.message || e}`)
  }
  const uid = created.id
  const number = created.number || null

  const nowIso = new Date().toISOString()
  await c.from('workshop_bookings').update({
    myob_invoice_uid: uid, // Xero InvoiceID while the module is on Xero
    status: 'invoiced',
    completed_at: nowIso,
    total_ex_gst: subtotal,
    total_inc_gst: totalAmount,
    updated_at: nowIso,
  }).eq('id', bookingId)

  await c.from('workshop_invoices').insert({
    customer_id: booking.customer_id || null,
    booking_id: bookingId,
    myob_invoice_uid: uid,
    status: mode === 'order' ? 'pending' : 'sent',
    subtotal, gst: totalTax, total: totalAmount,
    issue_date: today,
    order_number: (booking as any).order_number || null,
    third_party_customer_id: (booking as any).third_party_customer_id || null,
  })

  // Portal stock deduction — the shared movement-ledger routine (idempotent).
  let stockWarning: string | null = null
  try { stockWarning = await deductJobStock(bookingId, performedBy) }
  catch (e: any) { stockWarning = `Stock deduction failed: ${e?.message || e}` }

  await logWorkshopActivity(c, {
    action: 'finalised', entity: 'booking', entity_id: bookingId,
    detail: `Pushed to Xero as ${mode === 'order' ? 'draft invoice' : 'invoice'}${number ? ` #${number}` : ''} (${money(totalAmount)} inc)${stockWarning ? ` — ${stockWarning}` : ''}`,
    actor_id: performedBy,
  })

  const letter = await maybeAutoLetterForBooking(bookingId, totalAmount, uid)

  return {
    myob_uid: uid, myob_number: number, mode, status: 'created',
    stock_warning: stockWarning, letter,
    provider_warning: warnings.length ? warnings.join(' ') : null,
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 2. Un-finalise / void
// ═══════════════════════════════════════════════════════════════════════

export async function voidWorkshopDoc(bookingId: string, performedBy: string | null = null): Promise<UnfinaliseResult> {
  if ((await accountingProvider(ENTITY, MODULE)) === 'myob') {
    return unfinaliseJob(bookingId, performedBy)
  }
  return voidWorkshopDocXero(bookingId, performedBy)
}

// Mirrors lib/workshop-myob-invoice.ts::unfinaliseJob — the MYOB DELETE
// (Order/Invoice × Item/Service probing) becomes one adapter.voidDocument,
// which handles Xero's rule itself (DRAFT → DELETED, AUTHORISED → VOIDED).
async function voidWorkshopDocXero(bookingId: string, performedBy: string | null): Promise<UnfinaliseResult> {
  const c = sb()
  const { data: booking, error } = await c.from('workshop_bookings')
    .select('id, status, myob_invoice_uid').eq('id', bookingId).maybeSingle()
  if (error) throw new Error(`Job load failed: ${error.message}`)
  if (!booking) throw new Error('Job not found')

  const { data: moves } = await c.from('workshop_stock_movements')
    .select('id, inventory_id, qty').eq('booking_id', bookingId).is('reversed_at', null)
  if (!booking.myob_invoice_uid && (!moves || moves.length === 0)) {
    throw new WorkshopInvoiceError('not_finalised', 'This job hasn’t been finalised — nothing to reverse.')
  }

  const { data: pays } = await c.from('workshop_payments')
    .select('id').eq('booking_id', bookingId).eq('posted_to_myob', true).is('deleted_at', null).limit(1)
  if (pays && pays.length > 0) {
    throw new WorkshopInvoiceError('payment_posted', 'A payment has been posted against this invoice. Delete the payment in Xero first, then un-finalise.')
  }

  let remoteVoided = false
  if (booking.myob_invoice_uid) {
    const adapter = new XeroAdapter(ENTITY)
    try {
      await adapter.voidDocument('invoice', booking.myob_invoice_uid)
      remoteVoided = true
    } catch (e: any) {
      const msg = String(e?.message || e)
      // Already gone in Xero = fine (matches the MYOB all-404 case).
      if (!/not found/i.test(msg)) {
        throw new WorkshopInvoiceError('myob_error', `Xero wouldn’t void the invoice — ${msg}`)
      }
    }
  }

  // Restore stock from the movement ledger — identical to the MYOB path.
  let restocked = 0
  for (const m of (moves || []) as any[]) {
    const { data: inv } = await c.from('workshop_inventory').select('quantity, available').eq('id', m.inventory_id).maybeSingle()
    if (inv) {
      await c.from('workshop_inventory').update({
        quantity: round2((Number(inv.quantity) || 0) + (Number(m.qty) || 0)),
        available: round2((Number(inv.available) || 0) + (Number(m.qty) || 0)),
      }).eq('id', m.inventory_id)
    }
    await c.from('workshop_stock_movements').update({ reversed_at: new Date().toISOString() }).eq('id', m.id)
    restocked++
  }

  if (booking.myob_invoice_uid) {
    await c.from('workshop_invoices').delete().eq('booking_id', bookingId).eq('myob_invoice_uid', booking.myob_invoice_uid)
  }
  await c.from('workshop_bookings').update({
    myob_invoice_uid: null,
    status: 'done',
    updated_at: new Date().toISOString(),
  }).eq('id', bookingId)

  await logWorkshopActivity(c, {
    action: 'unfinalised', entity: 'booking', entity_id: bookingId,
    detail: `Xero invoice ${remoteVoided ? 'voided' : 'already gone'}; ${restocked} part line${restocked === 1 ? '' : 's'} restocked; status → done`,
    actor_id: performedBy,
  })

  return { myob_deleted: remoteVoided, restocked, status: 'done' }
}

// ═══════════════════════════════════════════════════════════════════════
// 3. Customer payment
// ═══════════════════════════════════════════════════════════════════════

export async function applyWorkshopPayment(
  bookingId: string,
  opts: { amount: number; tender: PaymentTender; note?: string | null },
  performedBy: string | null = null,
): Promise<JobPaymentResult> {
  if ((await accountingProvider(ENTITY, MODULE)) === 'myob') {
    return recordJobPayment(bookingId, opts, performedBy)
  }
  return applyWorkshopPaymentXero(bookingId, opts, performedBy)
}

// Mirrors lib/workshop-myob-invoice.ts::recordJobPayment. Xero payments only
// need the invoice + a bank account code (no customer/contact), so the
// customer_not_synced gate doesn't apply; everything else is identical.
async function applyWorkshopPaymentXero(
  bookingId: string,
  opts: { amount: number; tender: PaymentTender; note?: string | null },
  performedBy: string | null,
): Promise<JobPaymentResult> {
  const c = sb()
  const amount = round2(Number(opts.amount) || 0)
  if (!(amount > 0)) throw new WorkshopPaymentError('no_amount', 'Enter a payment amount greater than zero.')

  const { data: booking, error } = await c
    .from('workshop_bookings')
    .select('id, status, total_inc_gst, myob_invoice_uid')
    .eq('id', bookingId).maybeSingle()
  if (error) throw new Error(`Job load failed: ${error.message}`)
  if (!booking) throw new Error('Job not found')

  const settings = await getWorkshopSettings()
  const tender = opts.tender
  const acct = (settings.payment_accounts || {})[tender]

  // Same gate as MYOB: posting enabled + a posted invoice + not order/draft
  // mode (Xero DRAFT invoices can't take payments either).
  const wantRemote = settings.myob_posting_enabled && !!booking.myob_invoice_uid && !settings.invoice_as_order
  let remotePaymentId: string | null = null
  let postedRemote = false

  if (wantRemote) {
    if (!acct?.uid) throw new WorkshopPaymentError('payment_account_not_set', `No deposit account set for "${tender}". Set it in Workshop Settings → MYOB accounts.`)
    const codeLookup = await xeroAccountCodeForMyobUid(acct.uid)
    if (!codeLookup.ok) throw new WorkshopPaymentError('payment_account_not_set', mappingMissing(codeLookup.missing))
    const adapter = new XeroAdapter(ENTITY)
    const today = new Date().toISOString().substring(0, 10)
    try {
      const p = await adapter.applyPayment({
        invoiceId: booking.myob_invoice_uid, // Xero InvoiceID under Xero mode
        amount,
        dateIso: today,
        accountCode: codeLookup.code,
      })
      remotePaymentId = p.id
    } catch (e: any) {
      throw new WorkshopPaymentError('myob_error', `Xero payment failed: ${e?.message || e}`)
    }
    postedRemote = true
  }

  const { data: inserted, error: insErr } = await c.from('workshop_payments').insert({
    booking_id: bookingId, amount, tender,
    method: acct?.method || null,
    deposit_account_uid: acct?.uid || null,
    deposit_account_name: acct?.name || null,
    myob_payment_uid: remotePaymentId, // Xero PaymentID under Xero mode
    posted_to_myob: postedRemote,
    note: opts.note || null,
    created_by: performedBy,
  }).select('id').single()
  if (insErr) throw new Error(`Payment save failed: ${insErr.message}`)

  const { data: paysAll } = await c.from('workshop_payments').select('amount').eq('booking_id', bookingId).is('deleted_at', null)
  const paidTotal = round2((paysAll || []).reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0))
  const total = round2(Number(booking.total_inc_gst) || 0)
  const balance = round2(total - paidTotal)
  let status = booking.status as string
  if (total > 0 && balance <= 0 && ['invoiced', 'done', 'ready'].includes(status)) {
    status = 'paid'
    await c.from('workshop_bookings').update({ status, updated_at: new Date().toISOString() }).eq('id', bookingId)
  }

  return { payment_id: inserted.id, posted_to_myob: postedRemote, myob_payment_uid: remotePaymentId, paid_total: paidTotal, balance, status }
}

// ═══════════════════════════════════════════════════════════════════════
// 4. Credit note
// ═══════════════════════════════════════════════════════════════════════

export async function pushWorkshopCreditNote(
  input: WorkshopCreditNoteInput,
  performedBy: string | null = null,
  actorName: string | null = null,
): Promise<CreditNoteResult> {
  if ((await accountingProvider(ENTITY, MODULE)) === 'myob') {
    return createCreditNoteInMyob(input, performedBy, actorName)
  }
  return pushWorkshopCreditNoteXero(input, performedBy, actorName)
}

// Mirrors lib/workshop-credit-note.ts::createCreditNote — LOCAL-FIRST record,
// then a best-effort remote push. The remote leg is a real Xero ACCRECCREDIT
// credit note (nicer than MYOB's negative-invoice workaround). Differences,
// all surfaced in myob_warning: restock_parts has no Xero effect (no item
// lines), and the cash-refund leg (MYOB Sale/CreditRefund) isn't wired — the
// refund records locally only.
async function pushWorkshopCreditNoteXero(
  input: WorkshopCreditNoteInput,
  performedBy: string | null,
  actorName: string | null,
): Promise<CreditNoteResult> {
  const c = sb()
  if (!input.booking_id && !input.invoice_id) throw new WorkshopCreditNoteError('no_source', 'booking_id or invoice_id required')

  // ── Load the source (job or imported invoice) + its lines ──
  let customerId: string | null = null
  let customer: { myob_uid?: string | null; name?: string | null; email?: string | null } | null = null
  let sourceTotalInc = 0
  let sourceLines: any[] = []
  let sourceLabel = ''

  if (input.booking_id) {
    const { data: booking, error } = await c.from('workshop_bookings')
      .select('id, customer_id, total_inc_gst, myob_invoice_uid, customer:workshop_customers!customer_id(id, name, email, myob_uid)')
      .eq('id', input.booking_id).maybeSingle()
    if (error || !booking) throw new WorkshopCreditNoteError('no_source', error?.message || 'Job not found')
    const cust: any = Array.isArray(booking.customer) ? booking.customer[0] : booking.customer
    customerId = booking.customer_id || null
    customer = cust || null
    sourceTotalInc = round2(Number(booking.total_inc_gst) || 0)
    sourceLabel = `job ${booking.id.slice(0, 8)}`
    const { data: lines } = await c.from('workshop_booking_lines')
      .select('*')
      .eq('booking_id', input.booking_id).order('sort_order', { ascending: true })
    sourceLines = lines || []
  } else {
    const { data: invoice, error } = await c.from('workshop_invoices')
      .select('id, customer_id, total, booking_id, md_id, customer:workshop_customers!customer_id(id, name, email, myob_uid)')
      .eq('id', input.invoice_id!).maybeSingle()
    if (error || !invoice) throw new WorkshopCreditNoteError('no_source', error?.message || 'Invoice not found')
    const cust: any = Array.isArray(invoice.customer) ? invoice.customer[0] : invoice.customer
    customerId = invoice.customer_id || null
    customer = cust || null
    sourceTotalInc = round2(Number(invoice.total) || 0)
    sourceLabel = invoice.md_id ? `invoice #${invoice.md_id}` : `invoice ${invoice.id.slice(0, 8)}`
    const { data: lines } = await c.from('workshop_invoice_lines')
      .select('*')
      .eq('invoice_id', input.invoice_id!).order('sort_order', { ascending: true })
    sourceLines = lines || []
  }

  const lineExOf = (l: any) => l.total_ex_gst != null ? Number(l.total_ex_gst) : (Number(l.qty) || 0) * (Number(l.unit_price_ex_gst) || 0)

  // ── Build credit lines + totals (positive numbers) — same math as MYOB ──
  let cnLines: any[] = []
  let subtotal = 0, gst = 0
  if (input.kind === 'lines') {
    const wanted = new Set(input.line_ids || [])
    if (!wanted.size) throw new WorkshopCreditNoteError('no_lines', 'Pick at least one line to credit.')
    for (const ln of sourceLines) {
      if (!wanted.has(ln.id)) continue
      const fullQty = Number(ln.qty) || 1
      const qty = Math.min(fullQty, Math.max(0, Number(input.qty_overrides?.[ln.id] ?? fullQty)))
      if (!(qty > 0)) continue
      const unit = fullQty ? round2(lineExOf(ln) / fullQty) : round2(lineExOf(ln))
      const ex = round2(unit * qty)
      const rate = ln.gst_rate != null ? Number(ln.gst_rate) : 0.10
      cnLines.push({
        source_line_id: ln.id, line_type: ln.line_type || 'fee', description: ln.description || ln.part_number || ln.line_type,
        part_number: ln.part_number || null, qty, unit_price_ex_gst: unit, gst_rate: rate, total_ex_gst: ex,
        inventory_id: ln.inventory_id || null, sort_order: cnLines.length,
      })
      subtotal += ex
      if (rate > 0) gst += ex * rate
    }
    if (!cnLines.length) throw new WorkshopCreditNoteError('no_lines', 'No creditable lines selected.')
  } else {
    const amountInc = round2(Number(input.amount) || 0)
    if (!(amountInc > 0)) throw new WorkshopCreditNoteError('no_amount', 'Enter a credit amount greater than zero.')
    const ex = round2(amountInc / 1.1)
    cnLines = [{
      source_line_id: null, line_type: 'fee', description: input.reason ? `Credit — ${input.reason}` : 'Credit',
      part_number: null, qty: 1, unit_price_ex_gst: ex, gst_rate: 0.10, total_ex_gst: ex,
      inventory_id: null, sort_order: 0,
    }]
    subtotal = ex
    gst = round2(amountInc - ex)
  }
  subtotal = round2(subtotal); gst = round2(gst)
  const totalInc = round2(subtotal + gst)

  // ── Over-credit guard: total of all credits ≤ source total ──
  if (sourceTotalInc > 0) {
    const priorQ = c.from('workshop_credit_notes').select('total_inc').is('deleted_at', null)
    const { data: prior } = input.booking_id ? await priorQ.eq('booking_id', input.booking_id) : await priorQ.eq('invoice_id', input.invoice_id!)
    const priorTotal = round2((prior || []).reduce((s: number, r: any) => s + (Number(r.total_inc) || 0), 0))
    if (totalInc + priorTotal > sourceTotalInc + 0.01) {
      throw new WorkshopCreditNoteError('over_credit', `Credit ($${totalInc.toFixed(2)}) plus prior credits ($${priorTotal.toFixed(2)}) exceeds the ${sourceLabel} total ($${sourceTotalInc.toFixed(2)}).`)
    }
  }

  // ── Insert local record FIRST (local-first, exactly like the MYOB path) ──
  const { data: cn, error: cnErr } = await c.from('workshop_credit_notes').insert({
    booking_id: input.booking_id || null, invoice_id: input.invoice_id || null, customer_id: customerId,
    reason: input.reason || null, kind: input.kind,
    subtotal_ex_gst: subtotal, gst, total_inc: totalInc,
    restock_parts: !!input.restock_parts, created_by: performedBy,
  }).select('id, cn_seq').single()
  if (cnErr) throw new Error(`Credit note save failed: ${cnErr.message}`)
  const cnNumber = `CN-${cn.cn_seq}`
  await c.from('workshop_credit_note_lines').insert(cnLines.map(l => ({ ...l, credit_note_id: cn.id })))

  // ── Xero push (best-effort): real ACCRECCREDIT credit note ──
  const settings = await getWorkshopSettings()
  let postedRemote = false
  let remoteNumber: string | null = null
  let warning: string | null = null
  const addWarning = (w: string) => { warning = warning ? `${warning} ${w}` : w }

  if (!settings.myob_posting_enabled) {
    addWarning('Accounting posting is off — credit recorded locally only.')
  } else if (!customer?.name) {
    addWarning('Customer has no name — credit recorded locally only.')
  } else {
    try {
      const refundAcctUid = settings.refund_account_uid || settings.part_sale_account_uid || settings.myob_sales_account_uid
      if (!refundAcctUid) throw new WorkshopCreditNoteError('refund_account_not_set', 'No refund/sales account configured in Workshop Settings → MYOB accounts.')
      const codeLookup = await xeroAccountCodeForMyobUid(refundAcctUid)
      if (!codeLookup.ok) throw new WorkshopCreditNoteError('refund_account_not_set', mappingMissing(codeLookup.missing))

      const adapter = new XeroAdapter(ENTITY)
      const contactId = await resolveXeroContactId(adapter, customer)

      const xeroLines: NeutralLine[] = cnLines.map(l => {
        const rate = Number(l.gst_rate) || 0
        const ex = round2(Number(l.total_ex_gst) || 0)
        return {
          description: `Credit: ${l.description || l.line_type}${l.part_number ? ` (${l.part_number})` : ''}`.substring(0, 255),
          amount: round2(ex * (1 + rate)), // adapter wants GST-INCLUSIVE, positive
          accountCode: codeLookup.code,
          taxType: rate > 0 ? 'GST' : 'FRE',
        }
      })

      const res = await adapter.createCreditNote({
        contactId,
        kind: 'sale',
        lines: xeroLines,
        reference: cnNumber,
        dateIso: new Date().toISOString().substring(0, 10),
      })
      remoteNumber = res.number || null
      await c.from('workshop_credit_notes').update({ myob_credit_uid: res.id, myob_credit_number: remoteNumber, myob_written_at: new Date().toISOString() }).eq('id', cn.id)
      postedRemote = true
      if (input.restock_parts) {
        addWarning('Restock has no Xero effect (posted as account lines, not item lines) — adjust stock in Xero manually if it tracks these items.')
      }
    } catch (e: any) {
      const w = `Credit recorded locally, but the Xero post failed: ${e?.message || e}`.substring(0, 480)
      addWarning(w)
      await c.from('workshop_credit_notes').update({ myob_write_error: w }).eq('id', cn.id)
    }
  }

  // ── Refund leg: negative payment row. The MYOB Sale/CreditRefund cash-out
  //    has no wired Xero equivalent — refund stays local, staff settle the
  //    credit in Xero. ──
  let refunded = false
  const refundPostedRemote = false
  if (input.refund?.tender) {
    const acct = (settings.payment_accounts || {})[input.refund.tender]
    await c.from('workshop_payments').insert({
      booking_id: input.booking_id || null, invoice_id: input.invoice_id || null,
      amount: -totalInc, tender: input.refund.tender, kind: 'refund', credit_note_id: cn.id,
      method: acct?.method || null, deposit_account_uid: acct?.uid || null, deposit_account_name: acct?.name || null,
      posted_to_myob: false, note: `Refund for ${cnNumber}${input.reason ? ` — ${input.reason}` : ''}`,
      created_by: performedBy,
    })
    refunded = true
    await c.from('workshop_credit_notes').update({ refunded: true }).eq('id', cn.id)
    if (postedRemote) {
      addWarning('Refund recorded locally — the cash-refund leg isn’t wired for Xero; refund the credit note in Xero manually.')
    }
  }

  // ── Activity log — same as the MYOB path ──
  await logWorkshopActivity(c, {
    action: 'created', entity: 'credit_note', entity_id: cn.id, entity_label: cnNumber,
    detail: `$${totalInc.toFixed(2)} credit against ${sourceLabel}${input.reason ? ` — ${input.reason}` : ''}${postedRemote ? ' (Xero)' : ''}`,
    actor_id: performedBy, actor_name: actorName,
  })
  if (refunded) {
    await logWorkshopActivity(c, {
      action: 'payment', entity: 'credit_note', entity_id: cn.id, entity_label: cnNumber,
      detail: `$${totalInc.toFixed(2)} refunded via ${input.refund!.tender} (local)`,
      actor_id: performedBy, actor_name: actorName,
    })
  }

  return {
    credit_note_id: cn.id, cn_number: cnNumber, total_inc: totalInc,
    posted_to_myob: postedRemote, myob_credit_number: remoteNumber, myob_warning: warning,
    refunded, refund_posted_to_myob: refundPostedRemote,
  }
}
