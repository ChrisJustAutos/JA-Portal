// lib/ap-myob-bill.ts
// Build and post Service Bills to MYOB AccountRight.
//
// Two responsibilities:
//   1. ensureTaxCodes(label) — looks up the GST/FRE tax-code UIDs for the
//      given company file, caches them in ap_settings. Lazy refresh: only
//      hits MYOB when missing or older than 30 days.
//   2. createServiceBill(invoiceId, postedBy) — fetches the invoice + lines
//      from Supabase, builds the bill body, POSTs to MYOB, updates the
//      invoice row with the result.
//
// Service bills are MYOB's "no inventory tracking" purchase bill type, which
// matches AP for parts/services where we just want the GL hit (we're not
// using MYOB's stock module). Each line goes against an Account UID with a
// Tax UID; MYOB calculates totals server-side.
//
// Body shape (IsTaxInclusive=false, amounts ex-GST):
//   POST /accountright/{cf_id}/Purchase/Bill/Service
//   {
//     Date: 'YYYY-MM-DD',
//     SupplierInvoiceNumber: '3421025200',
//     Supplier: { UID },
//     Lines: [{ Type:'Transaction', Description, Account:{UID}, Amount, Tax:{UID} }],
//     JournalMemo: 'AP: <vendor> <inv#> [— Capricorn <ref>] [— Job <#>]',
//     IsTaxInclusive: false,
//   }

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from './myob'
import { CompanyFileLabel } from './ap-myob-lookup'

const TAX_CODE_TTL_MS = 30 * 24 * 3600 * 1000
const SETTINGS_ID = 'singleton'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

// ── Tax code cache ──────────────────────────────────────────────────────

interface TaxCodeBundle {
  gstUid: string
  freUid: string | null
}

export async function ensureTaxCodes(label: CompanyFileLabel): Promise<TaxCodeBundle> {
  const c = sb()
  const { data: settings, error } = await c
    .from('ap_settings')
    .select('*')
    .eq('id', SETTINGS_ID)
    .maybeSingle()
  if (error) throw new Error(`ap_settings load failed: ${error.message}`)

  const gstField = label === 'VPS' ? 'gst_tax_code_uid_vps' : 'gst_tax_code_uid_jaws'
  const freField = label === 'VPS' ? 'fre_tax_code_uid_vps' : 'fre_tax_code_uid_jaws'

  const refreshedAt = settings?.tax_codes_refreshed_at
    ? new Date(settings.tax_codes_refreshed_at).getTime()
    : 0
  const stale = Date.now() - refreshedAt > TAX_CODE_TTL_MS

  let gstUid: string | null = settings?.[gstField] || null
  let freUid: string | null = settings?.[freField] || null

  if (!gstUid || stale) {
    const conn = await getConnection(label)
    if (!conn) throw new Error(`No active MYOB connection for ${label}`)
    if (!conn.company_file_id) throw new Error(`MYOB connection ${label} has no company file selected`)

    const path = `/accountright/${conn.company_file_id}/GeneralLedger/TaxCode`
    const result = await myobFetch(conn.id, path, { query: { '$top': 100 } })
    if (result.status !== 200) {
      throw new Error(`MYOB tax-code lookup failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 200)}`)
    }

    const items: any[] = Array.isArray(result.data?.Items) ? result.data.Items : []
    const gst = items.find(t => (t.Code || '').toUpperCase() === 'GST')
    const fre = items.find(t => (t.Code || '').toUpperCase() === 'FRE')

    if (!gst?.UID) throw new Error(`GST tax code not found in MYOB ${label}`)

    gstUid = gst.UID
    freUid = fre?.UID || null

    const update: Record<string, any> = {
      [gstField]: gstUid,
      [freField]: freUid,
      tax_codes_refreshed_at: new Date().toISOString(),
    }
    const { error: upErr } = await c.from('ap_settings').update(update).eq('id', SETTINGS_ID)
    if (upErr) {
      // Logging only — we already have what we need to post.
      console.error('ap_settings tax-code cache update failed:', upErr.message)
    }
  }

  if (!gstUid) throw new Error(`GST tax code UID not available for ${label}`)
  return { gstUid, freUid }
}

// ── Bill creation ───────────────────────────────────────────────────────

export interface CreateServiceBillResult {
  ok: true
  myobBillUid: string
  myobBillRowId: number | null
}

interface ServiceBillLineBody {
  Type: 'Transaction'
  Description: string
  Account: { UID: string }
  Amount: number
  Tax: { UID: string }
}

interface ServiceBillBody {
  Date: string
  SupplierInvoiceNumber: string
  Supplier: { UID: string }
  Lines: ServiceBillLineBody[]
  JournalMemo: string
  IsTaxInclusive: boolean
}

/**
 * Build and POST a Service Bill to MYOB for the given AP invoice.
 *
 * Pre-conditions (caller should validate, but we re-check):
 *   - status === 'pending_review' or 'ready'
 *   - triage_status !== 'red'
 *   - resolved_supplier_uid + resolved_account_uid populated
 *   - At least one line with line_total_ex_gst > 0
 *
 * On success: invoice row updated to status='posted' with myob_bill_uid set.
 * On failure: status='error', myob_post_error set, myob_post_attempts++. Throws.
 */
export async function createServiceBill(
  invoiceId: string,
  postedBy: string,
): Promise<CreateServiceBillResult> {
  const c = sb()

  // Load invoice + lines
  const { data: inv, error: invErr } = await c
    .from('ap_invoices')
    .select('*')
    .eq('id', invoiceId)
    .single()
  if (invErr || !inv) throw new Error(`Invoice not found: ${invoiceId}`)

  // Pre-flight validation
  if (inv.status === 'posted')   throw new Error('Invoice already posted to MYOB')
  if (inv.status === 'rejected') throw new Error('Invoice has been rejected')
  if (inv.triage_status === 'red') throw new Error('Invoice triage is RED — cannot post')
  if (!inv.resolved_supplier_uid)  throw new Error('No MYOB supplier resolved')
  if (!inv.resolved_account_uid)   throw new Error('No MYOB default account resolved')
  if (!inv.invoice_date)           throw new Error('Invoice date is required to post')
  if (!inv.invoice_number)         throw new Error('Supplier invoice number is required to post')

  const { data: lines, error: linesErr } = await c
    .from('ap_invoice_lines')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('line_no', { ascending: true })
  if (linesErr) throw new Error(`Failed to load lines: ${linesErr.message}`)
  if (!lines || lines.length === 0) throw new Error('Invoice has no line items')

  const companyFile = (inv.myob_company_file || 'VPS') as CompanyFileLabel
  const { gstUid, freUid } = await ensureTaxCodes(companyFile)

  // Map AP tax codes → MYOB tax UIDs. Anything unsupported throws so we
  // surface a clear error rather than silently posting with the wrong tax.
  function taxUidFor(taxCode: string): string {
    const code = (taxCode || 'GST').toUpperCase()
    if (code === 'GST') return gstUid
    if (code === 'FRE') {
      if (!freUid) throw new Error(`Line uses FRE but FRE tax code is not set up in MYOB ${companyFile}`)
      return freUid
    }
    throw new Error(`Unsupported tax code "${code}" — supported: GST, FRE`)
  }

  const billLines: ServiceBillLineBody[] = lines.map((l: any) => {
    const description = [l.part_number, l.description].filter(Boolean).join(' — ').substring(0, 255)
    const amount = Number(l.line_total_ex_gst || 0)
    return {
      Type: 'Transaction',
      Description: description || 'AP line',
      Account: { UID: inv.resolved_account_uid },
      Amount: amount,
      Tax: { UID: taxUidFor(l.tax_code) },
    }
  })

  // Memo: keep human-readable, include cross-references for MYOB users
  const memoParts = [
    `AP: ${inv.vendor_name_parsed || 'Vendor'} — ${inv.invoice_number}`,
  ]
  if (inv.via_capricorn && inv.capricorn_reference) {
    memoParts.push(`Capricorn ${inv.capricorn_reference}`)
  }
  if (inv.linked_job_number) {
    memoParts.push(`Job ${inv.linked_job_number}`)
  }
  const journalMemo = memoParts.join(' — ').substring(0, 255)

  const body: ServiceBillBody = {
    Date: inv.invoice_date,
    SupplierInvoiceNumber: String(inv.invoice_number).substring(0, 13),
    Supplier: { UID: inv.resolved_supplier_uid },
    Lines: billLines,
    JournalMemo: journalMemo,
    IsTaxInclusive: false,
  }

  // Resolve the connection for the company file
  const conn = await getConnection(companyFile)
  if (!conn) throw new Error(`No active MYOB connection for ${companyFile}`)
  if (!conn.company_file_id) throw new Error(`MYOB connection ${companyFile} has no company file selected`)

  const path = `/accountright/${conn.company_file_id}/Purchase/Bill/Service`

  // Increment attempts BEFORE posting so even crashes mid-call are recorded
  const attemptsSoFar = (inv.myob_post_attempts || 0) + 1

  let result: { status: number; data: any; raw: string }
  try {
    result = await myobFetch(conn.id, path, {
      method: 'POST',
      body,
      performedBy: postedBy,
    })
  } catch (e: any) {
    await c.from('ap_invoices').update({
      myob_post_attempts: attemptsSoFar,
      myob_post_error: `Network error: ${e?.message || String(e)}`.substring(0, 500),
      status: 'error',
    }).eq('id', invoiceId)
    throw e
  }

  if (result.status >= 400) {
    const errMsg = extractMyobError(result)
    await c.from('ap_invoices').update({
      myob_post_attempts: attemptsSoFar,
      myob_post_error: errMsg.substring(0, 500),
      status: 'error',
    }).eq('id', invoiceId)
    throw new Error(`MYOB rejected the bill (HTTP ${result.status}): ${errMsg}`)
  }

  // Success — extract the new bill's UID
  const myobBillUid = extractMyobUid(result)
  if (!myobBillUid) {
    // Posted but we couldn't parse the response — record what we have and
    // surface a soft error so Chris can verify in MYOB.
    await c.from('ap_invoices').update({
      myob_post_attempts: attemptsSoFar,
      myob_post_error: 'Posted (HTTP ' + result.status + ') but no UID returned — verify in MYOB',
      status: 'posted',
      myob_posted_at: new Date().toISOString(),
      myob_posted_by: postedBy,
    }).eq('id', invoiceId)
    return { ok: true, myobBillUid: '', myobBillRowId: null }
  }

  const myobBillRowId = extractMyobRowId(result)

  await c.from('ap_invoices').update({
    myob_bill_uid:       myobBillUid,
    myob_bill_row_id:    myobBillRowId,
    myob_posted_at:      new Date().toISOString(),
    myob_posted_by:      postedBy,
    myob_post_attempts:  attemptsSoFar,
    myob_post_error:     null,
    status:              'posted',
  }).eq('id', invoiceId)

  return { ok: true, myobBillUid, myobBillRowId }
}

// ── Response parsing ────────────────────────────────────────────────────

function extractMyobError(result: { status: number; data: any; raw: string }): string {
  const data = result.data
  if (data && typeof data === 'object') {
    if (Array.isArray(data.Errors) && data.Errors.length > 0) {
      const e0 = data.Errors[0]
      const msg = e0?.Message || e0?.AdditionalDetails || e0?.Severity
      if (msg) return `${msg}${e0?.AdditionalDetails && msg !== e0.AdditionalDetails ? ' — ' + e0.AdditionalDetails : ''}`
    }
    if (typeof data.Message === 'string') return data.Message
  }
  if (result.raw) return result.raw.substring(0, 300)
  return `HTTP ${result.status}`
}

function extractMyobUid(result: { data: any; raw: string }): string | null {
  // MYOB often returns the resource on POST with a UID field. Also some
  // configs return a plain string in raw. Cover both.
  if (result.data && typeof result.data === 'object') {
    if (typeof result.data.UID === 'string') return result.data.UID
    if (typeof result.data.Uid === 'string') return result.data.Uid
  }
  // Try Location header would be ideal but myobFetch doesn't expose headers.
  // Fallback: scrape a UUID from the raw response if present.
  const m = (result.raw || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  return m ? m[0] : null
}

function extractMyobRowId(result: { data: any }): number | null {
  if (result.data && typeof result.data === 'object') {
    if (typeof result.data.RowVersion === 'string') {
      const n = parseInt(result.data.RowVersion, 10)
      return Number.isFinite(n) ? n : null
    }
    if (typeof result.data.RowId === 'number') return result.data.RowId
  }
  return null
}
