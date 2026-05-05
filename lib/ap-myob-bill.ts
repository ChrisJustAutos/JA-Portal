// lib/ap-myob-bill.ts
// Build and post Service Bills to MYOB AccountRight, then attach the source
// PDF to the new bill.
//
// Two responsibilities:
//   1. ensureTaxCodes(label) — looks up the GST/FRE tax-code UIDs for the
//      given company file, caches them in ap_settings.
//   2. createServiceBill(invoiceId, postedBy) — fetches the invoice + lines
//      from Supabase, runs a MYOB-side duplicate pre-flight check, builds the
//      bill body, POSTs to MYOB, attaches the PDF, updates the invoice row.
//
// Per-line account override: if a line has its own `account_uid`, that wins
// over the invoice-level `resolved_account_uid`. Lines without a per-line
// account fall back to the invoice default (the ap_supplier_account_map
// preset, or the MYOB supplier card's default expense account).
//
// SMART ADOPT on duplicate detection:
//   The pre-flight check queries MYOB for existing bills with the same
//   SupplierInvoiceNumber + Supplier UID. **If a match is found, we ADOPT
//   the existing UID and mark this invoice as posted** instead of throwing
//   a "Duplicate in MYOB" error.
//
//   Why: the pre-flight only matches on (invoice number + supplier), which
//   uniquely identifies the same logical invoice. Whether it ended up in
//   MYOB via:
//     (a) A previous attempt of ours that succeeded but lost its DB update
//         (e.g. bulk-approve hitting a serverless function timeout),
//     (b) A manual bill entry in MYOB by a person, or
//     (c) An import from somewhere else,
//   the right behaviour is the same: don't create a second bill, just
//   record that this invoice is reconciled to the existing UID.
//
//   This makes bulk-approve idempotent and self-healing — re-running it
//   after a partial failure recovers cleanly without operator intervention.
//
// Bill body shape (IsTaxInclusive=false, amounts ex-GST):
//   POST /accountright/{cf_id}/Purchase/Bill/Service
//   {
//     Date, SupplierInvoiceNumber, Supplier:{UID},
//     Lines: [{ Type:'Transaction', Description, Account:{UID}, Total, TaxCode:{UID} }],
//     JournalMemo, IsTaxInclusive: false,
//     FreightAmount: 0, FreightTaxCode: {UID},
//     Subtotal, TotalTax, TotalAmount,
//   }
//
// Field naming gotchas (every one of these silently fails):
//   - Line tax field is `TaxCode` not `Tax`
//   - **Line amount field is `Total` not `Amount`** — matches CData column
//   - FreightTaxCode is required even when FreightAmount is 0
//   - Subtotal/TotalTax/TotalAmount must be sent on the body envelope
//
// Bill UID extraction: MYOB returns 201 with empty body; UID is in the
// `Location` response header. URL contains TWO UUIDs (cfId + bill UID),
// take the LAST one.
//
// Attachment body shape (per MYOB official .NET SDK BillAttachmentWrapper):
//   POST /accountright/{cf_id}/Purchase/Bill/Service/{billUid}/Attachment
//   { "Attachments": [ { "OriginalFileName": ..., "FileBase64Content": ... } ] }

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch, MyobConnection } from './myob'
import { CompanyFileLabel } from './ap-myob-lookup'

const TAX_CODE_TTL_MS = 30 * 24 * 3600 * 1000
const SETTINGS_ID = 'singleton'
const STORAGE_BUCKET = 'ap-invoices'
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

const GST_RATE = 0.10

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
      console.error('ap_settings tax-code cache update failed:', upErr.message)
    }
  }

  if (!gstUid) throw new Error(`GST tax code UID not available for ${label}`)
  return { gstUid, freUid }
}

// ── MYOB duplicate pre-flight ───────────────────────────────────────────

interface ExistingBillMatch {
  uid: string
  number: string | null
  date: string | null
  totalAmount: number | null
}

async function findExistingMyobBill(
  connId: string,
  cfId: string,
  supplierInvoiceNumber: string,
  supplierUid: string,
): Promise<ExistingBillMatch | null> {
  const escaped = String(supplierInvoiceNumber).replace(/'/g, "''")
  const filter = `SupplierInvoiceNumber eq '${escaped}'`

  const paths = [
    `/accountright/${cfId}/Purchase/Bill/Service`,
    `/accountright/${cfId}/Purchase/Bill/Item`,
  ]

  for (const path of paths) {
    const result = await myobFetch(connId, path, {
      query: { '$filter': filter, '$top': 10 },
    })
    if (result.status !== 200) continue

    const items: any[] = Array.isArray(result.data?.Items) ? result.data.Items : []
    const match = items.find(b => b?.Supplier?.UID === supplierUid)
    if (match) {
      return {
        uid: String(match.UID || ''),
        number: match.Number || null,
        date: match.Date || null,
        totalAmount: typeof match.TotalAmount === 'number' ? match.TotalAmount : null,
      }
    }
  }
  return null
}

// ── Bill creation ───────────────────────────────────────────────────────

export interface CreateServiceBillResult {
  ok: true
  myobBillUid: string
  myobBillRowId: number | null
  attachmentStatus: 'attached' | 'failed' | 'skipped' | 'no-pdf' | 'adopted'
  attachmentError?: string
  /** True when an existing MYOB bill was adopted instead of posting a new one. */
  adopted?: boolean
  /** When adopted, the existing MYOB bill number for the operator's reference. */
  adoptedBillNumber?: string | null
}

interface ServiceBillLineBody {
  Type: 'Transaction'
  Description: string
  Account: { UID: string }
  Total: number
  TaxCode: { UID: string }
}

interface ServiceBillBody {
  Date: string
  SupplierInvoiceNumber: string
  Supplier: { UID: string }
  Lines: ServiceBillLineBody[]
  JournalMemo: string
  IsTaxInclusive: boolean
  FreightAmount: number
  FreightTaxCode: { UID: string }
  Subtotal: number
  TotalTax: number
  TotalAmount: number
}

export async function createServiceBill(
  invoiceId: string,
  postedBy: string,
): Promise<CreateServiceBillResult> {
  const c = sb()

  const { data: inv, error: invErr } = await c
    .from('ap_invoices')
    .select('*')
    .eq('id', invoiceId)
    .single()
  if (invErr || !inv) throw new Error(`Invoice not found: ${invoiceId}`)

  if (inv.status === 'posted')   throw new Error('Invoice already posted to MYOB')
  if (inv.status === 'rejected') throw new Error('Invoice has been rejected')
  if (inv.triage_status === 'red') throw new Error('Invoice triage is RED — cannot post')
  if (!inv.resolved_supplier_uid)  throw new Error('No MYOB supplier resolved')
  if (!inv.invoice_date)           throw new Error('Invoice date is required to post')
  if (!inv.invoice_number)         throw new Error('Supplier invoice number is required to post')

  const { data: lines, error: linesErr } = await c
    .from('ap_invoice_lines')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('line_no', { ascending: true })
  if (linesErr) throw new Error(`Failed to load lines: ${linesErr.message}`)
  if (!lines || lines.length === 0) throw new Error('Invoice has no line items')

  const linesMissingAccount = lines.filter((l: any) =>
    !l.account_uid && !inv.resolved_account_uid
  )
  if (linesMissingAccount.length > 0) {
    const which = linesMissingAccount.map((l: any) => `#${l.line_no}`).join(', ')
    throw new Error(
      `Lines ${which} have no per-line account and no invoice-level default account is set — pick one or set a default.`
    )
  }

  const companyFile = (inv.myob_company_file || 'VPS') as CompanyFileLabel
  const { gstUid, freUid } = await ensureTaxCodes(companyFile)

  const conn = await getConnection(companyFile)
  if (!conn) throw new Error(`No active MYOB connection for ${companyFile}`)
  if (!conn.company_file_id) throw new Error(`MYOB connection ${companyFile} has no company file selected`)

  // ── Pre-flight: MYOB-side duplicate check (now SMART ADOPT) ──
  // If MYOB already has a bill with this SupplierInvoiceNumber + Supplier
  // UID, we adopt it rather than throwing. See module docblock for rationale.
  const existingMyob = await findExistingMyobBill(
    conn.id,
    conn.company_file_id,
    String(inv.invoice_number),
    String(inv.resolved_supplier_uid),
  )
  if (existingMyob) {
    const note = `Adopted existing MYOB bill #${existingMyob.number || '?'} dated ${existingMyob.date?.substring(0, 10) || '?'} (UID ${existingMyob.uid.substring(0, 8)}…) — already in MYOB with same SupplierInvoiceNumber + Supplier`

    const safeBillUid = existingMyob.uid && existingMyob.uid !== conn.company_file_id
      ? existingMyob.uid
      : null

    await c.from('ap_invoices').update({
      myob_bill_uid:       safeBillUid,
      myob_posted_at:      existingMyob.date || new Date().toISOString(),
      myob_post_attempts:  (inv.myob_post_attempts || 0) + 1,
      myob_post_error:     note,
      status:              'posted',
    }).eq('id', invoiceId)

    return {
      ok: true,
      myobBillUid: safeBillUid || '',
      myobBillRowId: null,
      attachmentStatus: 'adopted',
      attachmentError: undefined,
      adopted: true,
      adoptedBillNumber: existingMyob.number,
    }
  }

  function taxUidFor(taxCode: string): string {
    const code = (taxCode || 'GST').toUpperCase()
    if (code === 'GST') return gstUid
    if (code === 'FRE') {
      if (!freUid) throw new Error(`Line uses FRE but FRE tax code is not set up in MYOB ${companyFile}`)
      return freUid
    }
    throw new Error(`Unsupported tax code "${code}" — supported: GST, FRE`)
  }

  function rateFor(taxCode: string): number {
    return (taxCode || 'GST').toUpperCase() === 'FRE' ? 0 : GST_RATE
  }

  const billLines: ServiceBillLineBody[] = lines.map((l: any) => {
    const description = [l.part_number, l.description].filter(Boolean).join(' — ').substring(0, 255)
    const lineTotal = round2(Number(l.line_total_ex_gst || 0))
    const accountUid: string = l.account_uid || inv.resolved_account_uid
    return {
      Type: 'Transaction',
      Description: description || 'AP line',
      Account: { UID: accountUid },
      Total: lineTotal,
      TaxCode: { UID: taxUidFor(l.tax_code) },
    }
  })

  const subtotal = round2(billLines.reduce((s, l) => s + l.Total, 0))
  const totalTax = round2(lines.reduce((s: number, l: any) => {
    const lineEx = Number(l.line_total_ex_gst || 0)
    return s + lineEx * rateFor(l.tax_code)
  }, 0))
  const freightAmount = 0
  const totalAmount = round2(subtotal + totalTax + freightAmount)

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
    FreightAmount: freightAmount,
    FreightTaxCode: { UID: gstUid },
    Subtotal: subtotal,
    TotalTax: totalTax,
    TotalAmount: totalAmount,
  }

  const path = `/accountright/${conn.company_file_id}/Purchase/Bill/Service`
  const attemptsSoFar = (inv.myob_post_attempts || 0) + 1

  // ── Step 1: post the bill ──
  let result: { status: number; data: any; raw: string; headers: Record<string, string> }
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

  const myobBillUid = extractMyobUid(result)
  const myobBillRowId = extractMyobRowId(result)
  const safeBillUid = (myobBillUid && myobBillUid !== conn.company_file_id) ? myobBillUid : null

  // ── Step 2: attach the PDF (best effort) ──
  let attachmentStatus: 'attached' | 'failed' | 'skipped' | 'no-pdf' = 'skipped'
  let attachmentError: string | undefined

  if (!safeBillUid) {
    attachmentStatus = 'skipped'
    attachmentError = myobBillUid
      ? `Extracted UID looked like cfId — refusing to attach. Location="${result.headers?.['location'] || ''}"`
      : 'No MYOB bill UID returned — cannot attach PDF'
  } else if (!inv.pdf_storage_path) {
    attachmentStatus = 'no-pdf'
  } else {
    try {
      await attachPdfToBill({
        connId: conn.id,
        cfId: conn.company_file_id,
        billUid: safeBillUid,
        pdfStoragePath: inv.pdf_storage_path,
        filename: inv.pdf_filename || `${inv.invoice_number}.pdf`,
        postedBy,
      })
      attachmentStatus = 'attached'
    } catch (e: any) {
      attachmentStatus = 'failed'
      attachmentError = (e?.message || String(e)).substring(0, 400)
      console.error(`Bill ${safeBillUid} posted but attachment failed:`, attachmentError)
    }
  }

  // ── Step 3: persist final state ──
  const postUpdate: Record<string, any> = {
    myob_bill_uid:       safeBillUid || null,
    myob_bill_row_id:    myobBillRowId,
    myob_posted_at:      new Date().toISOString(),
    myob_posted_by:      postedBy,
    myob_post_attempts:  attemptsSoFar,
    status:              'posted',
  }
  if (attachmentStatus === 'failed') {
    postUpdate.myob_post_error = `Bill posted but PDF attachment failed: ${attachmentError}`
  } else if (attachmentStatus === 'skipped') {
    postUpdate.myob_post_error = `Bill posted: ${attachmentError}`
  } else {
    postUpdate.myob_post_error = null
  }

  await c.from('ap_invoices').update(postUpdate).eq('id', invoiceId)

  return {
    ok: true,
    myobBillUid: safeBillUid || '',
    myobBillRowId,
    attachmentStatus,
    attachmentError,
  }
}

// ── Attachment helper ───────────────────────────────────────────────────

async function attachPdfToBill(opts: {
  connId: string
  cfId: string
  billUid: string
  pdfStoragePath: string
  filename: string
  postedBy: string
}): Promise<void> {
  const { data: blob, error: dlErr } = await sb().storage
    .from(STORAGE_BUCKET)
    .download(opts.pdfStoragePath)
  if (dlErr || !blob) {
    throw new Error(`PDF fetch from Supabase storage failed: ${dlErr?.message || 'unknown'}`)
  }

  const arrayBuf = await blob.arrayBuffer()
  if (arrayBuf.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `PDF too large (${Math.round(arrayBuf.byteLength / 1024)}KB) — MYOB limit ${Math.round(MAX_ATTACHMENT_BYTES / 1024)}KB`
    )
  }

  const buffer = Buffer.from(arrayBuf)
  const base64 = buffer.toString('base64')

  const safeName = (opts.filename || 'invoice.pdf')
    .replace(/[^\x20-\x7E]/g, '_')
    .substring(0, 100)

  const path = `/accountright/${opts.cfId}/Purchase/Bill/Service/${opts.billUid}/Attachment`
  const result = await myobFetch(opts.connId, path, {
    method: 'POST',
    body: {
      Attachments: [
        {
          OriginalFileName:  safeName,
          FileBase64Content: base64,
        },
      ],
    },
    performedBy: opts.postedBy,
  })

  if (result.status >= 400) {
    throw new Error(`MYOB rejected attachment (HTTP ${result.status}): ${extractMyobError(result)}`)
  }

  const attachmentsArr = result.data?.Attachments
  if (Array.isArray(attachmentsArr) && attachmentsArr.length === 0) {
    throw new Error('MYOB returned 200 but Attachments[] is empty — body shape may be wrong')
  }
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

function extractMyobUid(result: { data: any; raw: string; headers: Record<string, string> }): string | null {
  if (result.data && typeof result.data === 'object') {
    if (typeof result.data.UID === 'string') return result.data.UID
    if (typeof result.data.Uid === 'string') return result.data.Uid
  }
  const location = result.headers?.['location']
  if (location) {
    const matches = location.match(UUID_REGEX_G)
    if (matches && matches.length > 0) return matches[matches.length - 1]
  }
  const matches = (result.raw || '').match(UUID_REGEX_G)
  return matches && matches.length > 0 ? matches[matches.length - 1] : null
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
