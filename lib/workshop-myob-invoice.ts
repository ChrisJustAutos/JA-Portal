// lib/workshop-myob-invoice.ts
//
// Push a workshop job to MYOB (VPS — Vehicle Performance Solutions) as a
// Service sale. Workshop lines are labour/parts/fees (no per-line MYOB item),
// so we use a Service sale where every line is an account line against one
// configured workshop sales account + the VPS GST/FRE tax codes.
//
//   POST /accountright/{cf}/Sale/{Order|Invoice}/Service
//   { Customer:{UID}, Date, Lines:[{ Type:'Transaction', Description,
//     Account:{UID}, Total, TaxCode:{UID} }], IsTaxInclusive:false,
//     Subtotal, TotalTax, TotalAmount, Comment, JournalMemo }
//
// Default mode is a Sale ORDER (sits in MYOB's Orders register, no GL impact —
// staff convert to an invoice in MYOB). Switch to INVOICE via workshop_settings.
// Idempotent on workshop_bookings.myob_invoice_uid. MYOB auto-numbers (no Number).

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from './myob'
import { WORKSHOP_MYOB_LABEL, PaymentAccounts, PaymentTender } from './workshop'

const UUID_REGEX_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
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

export interface WorkshopSettings {
  myob_sales_account_uid: string | null
  myob_sales_account_name: string | null
  invoice_as_order: boolean
  // Full MYOB account map (migration 039). myob_sales_account_* = default/labour.
  part_sale_account_uid: string | null
  part_sale_account_name: string | null
  discount_account_uid: string | null
  discount_account_name: string | null
  refund_account_uid: string | null
  refund_account_name: string | null
  tracking_category_uid: string | null
  tracking_category_name: string | null
  labour_item_uid: string | null
  labour_item_name: string | null
  payment_accounts: PaymentAccounts
  myob_posting_enabled: boolean
  // Letterhead/footer for printed + emailed documents (migration 036).
  business_name: string | null
  business_abn: string | null
  business_address: string | null
  business_phone: string | null
  business_email: string | null
  document_footer: string | null
  // SMS reminders (migration 034).
  sms_enabled: boolean
  sms_from: string | null
  booking_reminder_lead_hours: number
  diary_start_min: number
  diary_end_min: number
}

export async function getWorkshopSettings(): Promise<WorkshopSettings> {
  const { data } = await sb().from('workshop_settings').select('*').eq('id', 'singleton').maybeSingle()
  return {
    myob_sales_account_uid: data?.myob_sales_account_uid ?? null,
    myob_sales_account_name: data?.myob_sales_account_name ?? null,
    invoice_as_order: data?.invoice_as_order ?? true,
    business_name: data?.business_name ?? 'Vehicle Performance Solutions',
    business_abn: data?.business_abn ?? null,
    business_address: data?.business_address ?? null,
    business_phone: data?.business_phone ?? null,
    business_email: data?.business_email ?? null,
    document_footer: data?.document_footer ?? null,
    sms_enabled: data?.sms_enabled ?? false,
    sms_from: data?.sms_from ?? null,
    booking_reminder_lead_hours: Number(data?.booking_reminder_lead_hours ?? 24),
    diary_start_min: Number(data?.diary_start_min ?? 420),
    diary_end_min: Number(data?.diary_end_min ?? 1080),
    part_sale_account_uid: data?.part_sale_account_uid ?? null,
    part_sale_account_name: data?.part_sale_account_name ?? null,
    discount_account_uid: data?.discount_account_uid ?? null,
    discount_account_name: data?.discount_account_name ?? null,
    refund_account_uid: data?.refund_account_uid ?? null,
    refund_account_name: data?.refund_account_name ?? null,
    tracking_category_uid: data?.tracking_category_uid ?? null,
    tracking_category_name: data?.tracking_category_name ?? null,
    labour_item_uid: data?.labour_item_uid ?? null,
    labour_item_name: data?.labour_item_name ?? null,
    payment_accounts: (data?.payment_accounts as PaymentAccounts) ?? {},
    myob_posting_enabled: data?.myob_posting_enabled ?? false,
  }
}

export async function setWorkshopSettings(patch: Partial<WorkshopSettings>): Promise<void> {
  await sb().from('workshop_settings').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 'singleton')
}

// Resolve the workshop (VPS) file's GST + FRE/N-T tax-code UIDs, fetched live.
async function resolveTaxCodes(connId: string, cfId: string): Promise<{ gstUid: string; freUid: string }> {
  const r = await myobFetch(connId, `/accountright/${cfId}/GeneralLedger/TaxCode`, { query: { '$top': 200 } })
  if (r.status !== 200) throw new Error(`MYOB tax code fetch failed (HTTP ${r.status})`)
  const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
  let gst: string | undefined, fre: string | undefined, nt: string | undefined
  for (const it of items) {
    const code = String(it.Code || '').toUpperCase()
    if (code === 'GST' && it.UID) gst = it.UID
    else if (code === 'FRE' && it.UID) fre = it.UID
    else if (code === 'N-T' && it.UID) nt = it.UID
  }
  if (!gst) throw new Error(`${WORKSHOP_MYOB_LABEL} MYOB has no GST tax code`)
  return { gstUid: gst, freUid: fre || nt || gst }
}

// Live list of workshop (VPS) income accounts (for the admin sales-account picker).
export async function listIncomeAccounts(): Promise<Array<{ uid: string; displayId: string; name: string; type: string }>> {
  const conn = await getConnection(WORKSHOP_MYOB_LABEL)
  if (!conn || !conn.company_file_id) throw new Error(`${WORKSHOP_MYOB_LABEL} MYOB connection not configured`)
  const r = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/GeneralLedger/Account`, { query: { '$top': 1000 } })
  if (r.status !== 200) throw new Error(`MYOB Account fetch failed (HTTP ${r.status}): ${(r.raw || '').substring(0, 200)}`)
  const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
  return items
    .filter(a => !a.IsHeader && (a.Type === 'Income' || a.Type === 'OtherIncome'))
    .map(a => ({ uid: a.UID, displayId: a.DisplayID, name: a.Name, type: a.Type }))
    .sort((a, b) => a.displayId.localeCompare(b.displayId))
}

export interface MyobAccount { uid: string; displayId: string; name: string; type: string }

// Bank/asset accounts the workshop can deposit customer payments into
// (cash drawer, undeposited funds, cheque/bank). Bank-type in MYOB.
export async function listBankAccounts(): Promise<MyobAccount[]> {
  const conn = await getConnection(WORKSHOP_MYOB_LABEL)
  if (!conn || !conn.company_file_id) throw new Error(`${WORKSHOP_MYOB_LABEL} MYOB connection not configured`)
  const r = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/GeneralLedger/Account`, { query: { '$top': 1000 } })
  if (r.status !== 200) throw new Error(`MYOB Account fetch failed (HTTP ${r.status})`)
  const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
  return items
    .filter(a => !a.IsHeader && a.Type === 'Bank')
    .map(a => ({ uid: a.UID, displayId: a.DisplayID, name: a.Name, type: a.Type }))
    .sort((a, b) => a.displayId.localeCompare(b.displayId))
}

// MYOB tracking categories (AccountRight "Categories"), e.g. "Performance".
// Returns [] if categories aren't enabled on the file.
export async function listTrackingCategories(): Promise<Array<{ uid: string; name: string; displayId: string }>> {
  const conn = await getConnection(WORKSHOP_MYOB_LABEL)
  if (!conn || !conn.company_file_id) throw new Error(`${WORKSHOP_MYOB_LABEL} MYOB connection not configured`)
  const r = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/GeneralLedger/Category`, { query: { '$top': 1000 } })
  if (r.status !== 200) return []
  const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
  return items
    .filter(c => c.IsActive !== false)
    .map(c => ({ uid: c.UID, name: c.Name, displayId: c.DisplayID || '' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface JobInvoiceResult {
  myob_uid: string
  myob_number: string | null
  mode: 'order' | 'invoice'
  status: 'created' | 'already_written'
}

// Sentinel error codes the API surfaces to the UI.
export class WorkshopInvoiceError extends Error {
  code: 'customer_not_synced' | 'sales_account_not_set' | 'no_lines' | 'myob_error' | 'posting_disabled'
  constructor(code: WorkshopInvoiceError['code'], message: string) { super(message); this.code = code }
}

export async function createJobInvoiceInMyob(bookingId: string, performedBy: string | null = null): Promise<JobInvoiceResult> {
  const c = sb()

  const { data: booking, error: bErr } = await c
    .from('workshop_bookings')
    .select('id, status, customer_id, myob_invoice_uid, customer:workshop_customers(id, name, myob_uid)')
    .eq('id', bookingId)
    .maybeSingle()
  if (bErr) throw new Error(`Job load failed: ${bErr.message}`)
  if (!booking) throw new Error('Job not found')

  const settings = await getWorkshopSettings()

  // Idempotency
  if (booking.myob_invoice_uid) {
    return { myob_uid: booking.myob_invoice_uid, myob_number: null, mode: settings.invoice_as_order ? 'order' : 'invoice', status: 'already_written' }
  }

  // Master gate — nothing posts to MYOB until an admin turns it on (so we don't
  // double-post while MechanicDesk is still syncing the same VPS file).
  if (!settings.myob_posting_enabled) {
    throw new WorkshopInvoiceError('posting_disabled', 'MYOB posting is turned off. Turn it on in Workshop Settings → MYOB accounts once MechanicDesk is retired.')
  }

  const cust: any = Array.isArray(booking.customer) ? booking.customer[0] : booking.customer
  if (!cust?.myob_uid) {
    throw new WorkshopInvoiceError('customer_not_synced', 'This job’s customer has no MYOB link. Sync customers from MYOB (or pick a synced customer) first.')
  }
  if (!settings.myob_sales_account_uid) {
    throw new WorkshopInvoiceError('sales_account_not_set', 'No workshop sales account configured. An admin must pick the MYOB income account workshop sales post to.')
  }

  // Join inventory so part lines can resolve their MYOB item UID (stock + COGS).
  const { data: lines } = await c.from('workshop_booking_lines')
    .select('*, inventory:workshop_inventory(myob_uid)')
    .eq('booking_id', bookingId).order('sort_order', { ascending: true })
  if (!lines || lines.length === 0) throw new WorkshopInvoiceError('no_lines', 'Add at least one line item before invoicing.')

  const conn = await getConnection(WORKSHOP_MYOB_LABEL)
  if (!conn || !conn.company_file_id) throw new Error(`${WORKSHOP_MYOB_LABEL} MYOB connection not configured`)
  const { gstUid, freUid } = await resolveTaxCodes(conn.id, conn.company_file_id)

  // Item layout (when a Labour service item is configured): parts post as Item
  // lines so MYOB decrements stock + books COGS, and every non-part line uses
  // the Labour item — so the whole invoice is item lines and stays editable in
  // MYOB (no read-only "hybrid layout"). Without a Labour item, fall back to
  // account lines (parts → parts account, else default).
  const useItems = !!settings.labour_item_uid
  const defaultAcct = settings.myob_sales_account_uid
  const partAcct = settings.part_sale_account_uid || defaultAcct
  const myobLines: any[] = []
  let subtotal = 0, totalTax = 0
  for (const ln of lines as any[]) {
    const lineEx = round2((Number(ln.total_ex_gst) || 0) || (Number(ln.qty) * Number(ln.unit_price_ex_gst)))
    if (lineEx === 0 && !ln.description) continue
    const rate = Number(ln.gst_rate) || 0
    const taxable = rate > 0
    const taxUid = taxable ? gstUid : freUid
    const desc = `${ln.description || ln.part_number || ln.line_type}${ln.part_number ? ` (${ln.part_number})` : ''}`.substring(0, 255)
    if (useItems) {
      const inv: any = Array.isArray(ln.inventory) ? ln.inventory[0] : ln.inventory
      const itemUid = (ln.line_type === 'part' && inv?.myob_uid) ? inv.myob_uid : settings.labour_item_uid
      const qty = Number(ln.qty) || 1
      const unit = qty ? round2(lineEx / qty) : lineEx
      myobLines.push({ Type: 'Transaction', Item: { UID: itemUid }, Description: desc, ShipQuantity: qty, UnitPrice: unit, Total: lineEx, TaxCode: { UID: taxUid } })
    } else {
      const acctUid = ln.line_type === 'part' ? partAcct : defaultAcct
      myobLines.push({ Type: 'Transaction', Description: desc, Account: { UID: acctUid }, Total: lineEx, TaxCode: { UID: taxUid } })
    }
    subtotal += lineEx
    if (taxable) totalTax += lineEx * rate
  }
  subtotal = round2(subtotal); totalTax = round2(totalTax)
  const totalAmount = round2(subtotal + totalTax)
  if (myobLines.length === 0) throw new WorkshopInvoiceError('no_lines', 'No billable lines to invoice.')

  const mode: 'order' | 'invoice' = settings.invoice_as_order ? 'order' : 'invoice'
  const layout = useItems ? 'Item' : 'Service'
  const path = `/accountright/${conn.company_file_id}/Sale/${mode === 'order' ? 'Order' : 'Invoice'}/${layout}`
  const today = new Date().toISOString().substring(0, 10)
  const body: Record<string, any> = {
    Customer: { UID: cust.myob_uid },
    Date: today,
    Lines: myobLines,
    IsTaxInclusive: false,
    Subtotal: subtotal,
    TotalTax: totalTax,
    TotalAmount: totalAmount,
    Comment: `Workshop job ${bookingId} — via JA Portal`,
    JournalMemo: `Workshop job ${bookingId}`.substring(0, 255),
  }
  if (settings.tracking_category_uid) body.Category = { UID: settings.tracking_category_uid }

  const result = await myobFetch(conn.id, path, { method: 'POST', body, performedBy })
  if (result.status !== 201 && result.status !== 200) {
    throw new WorkshopInvoiceError('myob_error', `MYOB Sale.${mode} POST failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 300)}`)
  }

  const location = (result.headers || {})['location'] || ''
  const uuids = String(location).match(UUID_REGEX_G) || []
  const uid = uuids[uuids.length - 1] || null
  if (!uid || uid === conn.company_file_id) throw new WorkshopInvoiceError('myob_error', `MYOB accepted the sale but returned no UID: "${location}"`)

  let number: string | null = null
  try {
    const detail = await myobFetch(conn.id, `${path}/${uid}`)
    if (detail.status === 200 && detail.data?.Number) number = String(detail.data.Number)
  } catch { /* not fatal */ }

  const nowIso = new Date().toISOString()
  await c.from('workshop_bookings').update({
    myob_invoice_uid: uid,
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
  })

  return { myob_uid: uid, myob_number: number, mode, status: 'created' }
}

// ── Customer payments ────────────────────────────────────────────────────

export interface JobPaymentResult {
  payment_id: string
  posted_to_myob: boolean
  myob_payment_uid: string | null
  paid_total: number
  balance: number
  status: string
}

export class WorkshopPaymentError extends Error {
  code: 'no_amount' | 'payment_account_not_set' | 'customer_not_synced' | 'myob_error'
  constructor(code: WorkshopPaymentError['code'], message: string) { super(message); this.code = code }
}

/**
 * Record a customer payment against a job. Always saved locally (paid/balance
 * tracking); also posted to MYOB as a Sale/CustomerPayment — to the tender's
 * mapped deposit account — when posting is enabled, the job has a MYOB
 * **invoice** (orders can't take payments) and the customer is synced.
 */
export async function recordJobPayment(
  bookingId: string,
  opts: { amount: number; tender: PaymentTender; note?: string | null },
  performedBy: string | null = null,
): Promise<JobPaymentResult> {
  const c = sb()
  const amount = round2(Number(opts.amount) || 0)
  if (!(amount > 0)) throw new WorkshopPaymentError('no_amount', 'Enter a payment amount greater than zero.')

  const { data: booking, error } = await c
    .from('workshop_bookings')
    .select('id, status, total_inc_gst, myob_invoice_uid, customer:workshop_customers(myob_uid)')
    .eq('id', bookingId).maybeSingle()
  if (error) throw new Error(`Job load failed: ${error.message}`)
  if (!booking) throw new Error('Job not found')

  const settings = await getWorkshopSettings()
  const tender = opts.tender
  const acct = (settings.payment_accounts || {})[tender]
  const cust: any = Array.isArray(booking.customer) ? booking.customer[0] : booking.customer

  // MYOB posting requires: enabled + a MYOB invoice (not an order) + synced
  // customer + a deposit account for this tender.
  const wantMyob = settings.myob_posting_enabled && !!booking.myob_invoice_uid && !settings.invoice_as_order
  let myobPaymentUid: string | null = null
  let postedToMyob = false

  if (wantMyob) {
    if (!cust?.myob_uid) throw new WorkshopPaymentError('customer_not_synced', 'Customer has no MYOB link — can’t post the payment to MYOB.')
    if (!acct?.uid) throw new WorkshopPaymentError('payment_account_not_set', `No MYOB deposit account set for "${tender}". Set it in Workshop Settings → MYOB accounts.`)
    const conn = await getConnection(WORKSHOP_MYOB_LABEL)
    if (!conn || !conn.company_file_id) throw new Error(`${WORKSHOP_MYOB_LABEL} MYOB connection not configured`)
    const today = new Date().toISOString().substring(0, 10)
    const body: Record<string, any> = {
      Date: today + 'T00:00:00',
      Customer: { UID: cust.myob_uid },
      DepositTo: 'Account',
      Account: { UID: acct.uid },
      PaymentMethod: acct.method || 'Other',
      AmountReceived: amount,
      Memo: `Workshop job ${bookingId} payment`.substring(0, 255),
      Invoices: [{ UID: booking.myob_invoice_uid, AmountApplied: amount, Type: 'Invoice' }],
    }
    const r = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Sale/CustomerPayment`, { method: 'POST', body, performedBy })
    if (r.status !== 201 && r.status !== 200) {
      throw new WorkshopPaymentError('myob_error', `MYOB CustomerPayment failed (HTTP ${r.status}): ${(r.raw || '').substring(0, 300)}`)
    }
    const loc = (r.headers || {})['location'] || (r.headers || {})['Location'] || ''
    const uuids = String(loc).match(UUID_REGEX_G) || []
    myobPaymentUid = uuids[uuids.length - 1] || null
    if (myobPaymentUid === conn.company_file_id) myobPaymentUid = null
    postedToMyob = true
  }

  const { data: inserted, error: insErr } = await c.from('workshop_payments').insert({
    booking_id: bookingId, amount, tender,
    method: acct?.method || null,
    deposit_account_uid: acct?.uid || null,
    deposit_account_name: acct?.name || null,
    myob_payment_uid: myobPaymentUid,
    posted_to_myob: postedToMyob,
    note: opts.note || null,
    created_by: performedBy,
  }).select('id').single()
  if (insErr) throw new Error(`Payment save failed: ${insErr.message}`)

  const { data: pays } = await c.from('workshop_payments').select('amount').eq('booking_id', bookingId)
  const paidTotal = round2((pays || []).reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0))
  const total = round2(Number(booking.total_inc_gst) || 0)
  const balance = round2(total - paidTotal)
  let status = booking.status as string
  if (total > 0 && balance <= 0 && ['invoiced', 'done', 'ready'].includes(status)) {
    status = 'paid'
    await c.from('workshop_bookings').update({ status, updated_at: new Date().toISOString() }).eq('id', bookingId)
  }

  return { payment_id: inserted.id, posted_to_myob: postedToMyob, myob_payment_uid: myobPaymentUid, paid_total: paidTotal, balance, status }
}

export async function listJobPayments(bookingId: string): Promise<{ payments: any[]; paid_total: number }> {
  const c = sb()
  const { data } = await c.from('workshop_payments').select('*').eq('booking_id', bookingId).order('created_at', { ascending: true })
  const paid = round2((data || []).reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0))
  return { payments: data || [], paid_total: paid }
}
