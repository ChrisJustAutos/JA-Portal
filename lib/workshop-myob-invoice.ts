// lib/workshop-myob-invoice.ts
//
// Push a workshop job to MYOB (JAWS) as a Service sale. Workshop lines are
// labour/parts/fees (no per-line MYOB item), so we use a Service sale where
// every line is an account line against one configured workshop sales account
// + the JAWS GST/FRE tax codes.
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
import { ensureJawsTaxCodes } from './b2b-settings'

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
}

export async function getWorkshopSettings(): Promise<WorkshopSettings> {
  const { data } = await sb().from('workshop_settings').select('*').eq('id', 'singleton').maybeSingle()
  return {
    myob_sales_account_uid: data?.myob_sales_account_uid ?? null,
    myob_sales_account_name: data?.myob_sales_account_name ?? null,
    invoice_as_order: data?.invoice_as_order ?? true,
  }
}

export async function setWorkshopSettings(patch: Partial<WorkshopSettings>): Promise<void> {
  await sb().from('workshop_settings').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 'singleton')
}

// Live list of JAWS income accounts (for the admin sales-account picker).
export async function listJawsIncomeAccounts(): Promise<Array<{ uid: string; displayId: string; name: string; type: string }>> {
  const conn = await getConnection('JAWS')
  if (!conn || !conn.company_file_id) throw new Error('JAWS MYOB connection not configured')
  const r = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/GeneralLedger/Account`, { query: { '$top': 1000 } })
  if (r.status !== 200) throw new Error(`MYOB Account fetch failed (HTTP ${r.status}): ${(r.raw || '').substring(0, 200)}`)
  const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
  return items
    .filter(a => !a.IsHeader && (a.Type === 'Income' || a.Type === 'OtherIncome'))
    .map(a => ({ uid: a.UID, displayId: a.DisplayID, name: a.Name, type: a.Type }))
    .sort((a, b) => a.displayId.localeCompare(b.displayId))
}

export interface JobInvoiceResult {
  myob_uid: string
  myob_number: string | null
  mode: 'order' | 'invoice'
  status: 'created' | 'already_written'
}

// Sentinel error codes the API surfaces to the UI.
export class WorkshopInvoiceError extends Error {
  code: 'customer_not_synced' | 'sales_account_not_set' | 'no_lines' | 'myob_error'
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

  const cust: any = Array.isArray(booking.customer) ? booking.customer[0] : booking.customer
  if (!cust?.myob_uid) {
    throw new WorkshopInvoiceError('customer_not_synced', 'This job’s customer has no MYOB link. Sync customers from MYOB (or pick a synced customer) first.')
  }
  if (!settings.myob_sales_account_uid) {
    throw new WorkshopInvoiceError('sales_account_not_set', 'No workshop sales account configured. An admin must pick the MYOB income account workshop sales post to.')
  }

  const { data: lines } = await c.from('workshop_booking_lines').select('*').eq('booking_id', bookingId).order('sort_order', { ascending: true })
  if (!lines || lines.length === 0) throw new WorkshopInvoiceError('no_lines', 'Add at least one line item before invoicing.')

  const { gstUid, freUid } = await ensureJawsTaxCodes()
  const conn = await getConnection('JAWS')
  if (!conn) throw new Error('JAWS MYOB connection not configured')

  const acctUid = settings.myob_sales_account_uid
  const myobLines: any[] = []
  let subtotal = 0, totalTax = 0
  for (const ln of lines as any[]) {
    const lineEx = round2((Number(ln.total_ex_gst) || 0) || (Number(ln.qty) * Number(ln.unit_price_ex_gst)))
    if (lineEx === 0 && !ln.description) continue
    const rate = Number(ln.gst_rate) || 0
    const taxable = rate > 0
    const desc = `${ln.description || ln.part_number || ln.line_type}${ln.part_number ? ` (${ln.part_number})` : ''}`.substring(0, 255)
    myobLines.push({ Type: 'Transaction', Description: desc, Account: { UID: acctUid }, Total: lineEx, TaxCode: { UID: taxable ? gstUid : freUid } })
    subtotal += lineEx
    if (taxable) totalTax += lineEx * rate
  }
  subtotal = round2(subtotal); totalTax = round2(totalTax)
  const totalAmount = round2(subtotal + totalTax)
  if (myobLines.length === 0) throw new WorkshopInvoiceError('no_lines', 'No billable lines to invoice.')

  const mode: 'order' | 'invoice' = settings.invoice_as_order ? 'order' : 'invoice'
  const path = `/accountright/${conn.company_file_id}/Sale/${mode === 'order' ? 'Order' : 'Invoice'}/Service`
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
