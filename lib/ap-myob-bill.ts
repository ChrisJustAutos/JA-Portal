// lib/ap-myob-bill.ts
// Build and post Service Bills to MYOB AccountRight, then attach the source
// PDF to the new bill.
//
// Two responsibilities:
//   1. ensureTaxCodes(label) — looks up the GST/FRE tax-code UIDs for the
//      given company file, caches them in ap_settings.
//   2. createServiceBill(invoiceId, postedBy) — fetches the invoice + lines
//      from Supabase, runs a MYOB-side duplicate pre-flight check, builds the
//      bill body, POSTs to MYOB, attaches the PDF, updates the invoice row,
//      and records line→account history for future smart-pickup.
//
// Per-line account override: if a line has its own `account_uid`, that wins
// over the invoice-level `resolved_account_uid`. Lines without a per-line
// account fall back to the invoice default.
//
// SMART ADOPT on duplicate detection:
//   The pre-flight check queries MYOB for existing bills with the same
//   SupplierInvoiceNumber + Supplier UID. If a match is found, we ADOPT
//   the existing UID and mark this invoice as posted (instead of throwing
//   "Duplicate in MYOB"). This makes bulk-approve idempotent and self-
//   healing — re-running after a partial failure recovers cleanly.
//
// LINE→ACCOUNT HISTORY (B layer of smart pickup):
//   On successful post, recordPostedLineHistory increments bill_count for
//   each (supplier_uid, normalised description, account_uid) tuple. The
//   resolver in lib/ap-line-resolver.ts uses this to suggest accounts for
//   future invoices from the same supplier with similar line descriptions.
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
//   - Line amount field is `Total` not `Amount`
//   - FreightTaxCode is required even when FreightAmount is 0
//   - Subtotal/TotalTax/TotalAmount must be sent on the body envelope
//
// **GST PRECISION — STRICT HEADER RECONCILIATION (May 2026)**:
//   Hard requirement: the bill posted to MYOB MUST reconcile to the totals
//   on the source PDF. No 1-2c drift, no quiet "close enough" tolerance.
//
//   Strategy:
//     1. Read PDF header values: total_inc_gst, gst_amount, subtotal_ex_gst.
//        These are the authoritative numbers — what Amanda compares against
//        statements, Capricorn, vendor portals.
//     2. If header values are internally inconsistent (subtotal + gst !=
//        total within 2c rounding), trust total_inc_gst as the anchor and
//        derive: subtotal = total - gst. The total is the most prominent
//        and least-likely-to-be-misread number on the PDF.
//     3. Build line totals (each rounded to 2dp). Compute their sum.
//     4. Adjust the LARGEST-magnitude line by the delta needed to make the
//        line sum equal headerSubtotal exactly. This means lines always
//        sum to the PDF subtotal. The largest line absorbs the cents with
//        least visible impact.
//     5. If the adjustment delta is more than $1, the line items genuinely
//        don't match the header — extractor missed a line, freight not
//        captured, vendor discount wasn't itemised, etc. Refuse to post
//        with a clear error so the user can edit lines first. This is a
//        feature: silent line-nudging by $50 to "match" would be wrong.
//     6. Set Subtotal/TotalTax/TotalAmount on the envelope = the header
//        values, exactly. MYOB's internal tax math (per-line round-then-
//        sum) will agree because we adjusted the largest line.
//
//   Fallback (no header values present): compute subtotal as line sum,
//   compute tax PER LINE as round2(line.Total × rate) summed, total =
//   sub + tax. This matches MYOB's own internal calc so envelope and
//   recalc agree.
//
//   ALL adjustments + fallbacks log to console with the invoice ID so
//   anything weird shows up in Vercel logs for forensics.
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
import { recordPostedLineHistory } from './ap-line-resolver'
import { applyBillPayment } from './ap-payment'

const TAX_CODE_TTL_MS = 30 * 24 * 3600 * 1000
const SETTINGS_ID = 'singleton'
const STORAGE_BUCKET = 'ap-invoices'
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

const GST_RATE = 0.10

// Maximum delta we'll silently absorb by nudging the largest line so the
// line sum matches the PDF subtotal. Beyond this is a real discrepancy
// that needs manual review — extractor missed a line, vendor freight,
// etc. We refuse to post rather than silently shifting cash to the
// wrong line. $1 covers all reasonable rounding/cents quirks while
// catching genuine extraction errors.
const MAX_LINE_NUDGE = 1.00

// Maximum allowed inconsistency within the header itself (subtotal + gst
// vs total). 2c covers vendor rounding. Beyond this we still trust the
// header total but log a warning — the gst/subtotal printed on the PDF
// might have a typo.
const HEADER_CONSISTENCY_TOLERANCE = 0.02

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

export interface ExistingBillMatch {
  uid: string
  number: string | null
  date: string | null
  totalAmount: number | null
}

export async function findExistingMyobBill(
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
  adopted?: boolean
  adoptedBillNumber?: string | null
  /** When 'applied': payment was applied to a clearing account (e.g. Capricorn)
   *  immediately after the bill was posted. 'failed' means the bill is in
   *  MYOB but the payment didn't post — see paymentError for the reason. */
  paymentStatus?: 'applied' | 'failed' | 'skipped'
  paymentUid?: string | null
  paymentError?: string
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

  // Credit-note path: posts as a Bill with negative Totals (matches the
  // MYOB UI's "enter as bill with negative amounts" workflow). The
  // SupplierPayment that follows will also have a negative amount —
  // i.e. a Pay Refund crediting the clearing account.
  const isCreditNote = inv.is_credit_note === true

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

  // ── Pre-flight: MYOB-side duplicate check (smart adopt) ──
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

  // ── Build bill lines (each Total rounded to 2dp) ──
  // Track per-line rates in a parallel array so tax math can use them
  // without mutating the line body shape MYOB expects.
  const billLines: ServiceBillLineBody[] = []
  const lineRates: number[] = []
  for (const l of lines) {
    const description = [l.part_number, l.description].filter(Boolean).join(' — ').substring(0, 255)
    const lineTotal = round2(Number(l.line_total_ex_gst || 0))
    const accountUid: string = l.account_uid || inv.resolved_account_uid
    billLines.push({
      Type: 'Transaction',
      Description: description || 'AP line',
      Account: { UID: accountUid },
      Total: lineTotal,
      TaxCode: { UID: taxUidFor(l.tax_code) },
    })
    lineRates.push(rateFor(l.tax_code))
  }

  // ── Determine authoritative subtotal / GST / total ──
  // STRICT MODE: PDF header is the source of truth. Bill envelope numbers
  // exactly match what Amanda sees on the printed invoice.
  const headerTotalRaw    = inv.total_inc_gst != null && Number.isFinite(Number(inv.total_inc_gst))    ? Number(inv.total_inc_gst)    : null
  const headerGstRaw      = inv.gst_amount != null && Number.isFinite(Number(inv.gst_amount))          ? Number(inv.gst_amount)       : null
  const headerSubtotalRaw = inv.subtotal_ex_gst != null && Number.isFinite(Number(inv.subtotal_ex_gst)) ? Number(inv.subtotal_ex_gst) : null

  const headerTotal    = headerTotalRaw    !== null ? round2(headerTotalRaw)    : null
  let   headerGst      = headerGstRaw      !== null ? round2(headerGstRaw)      : null
  let   headerSubtotal = headerSubtotalRaw !== null ? round2(headerSubtotalRaw) : null

  // Internal-consistency check on the header values themselves.
  // If subtotal + gst != total within tolerance, trust the total (the
  // most prominent number on the PDF) and re-derive the other two.
  if (headerTotal !== null && headerGst !== null && headerSubtotal !== null) {
    const impliedTotal = round2(headerSubtotal + headerGst)
    const internalDelta = round2(headerTotal - impliedTotal)
    if (Math.abs(internalDelta) > HEADER_CONSISTENCY_TOLERANCE) {
      console.warn(`AP ${invoiceId}: header values inconsistent — subtotal ${headerSubtotal.toFixed(2)} + gst ${headerGst.toFixed(2)} = ${impliedTotal.toFixed(2)}, but total says ${headerTotal.toFixed(2)} (delta ${internalDelta.toFixed(2)}). Trusting total + gst, re-deriving subtotal.`)
      headerSubtotal = round2(headerTotal - headerGst)
    }
  } else if (headerTotal !== null && headerGst !== null && headerSubtotal === null) {
    headerSubtotal = round2(headerTotal - headerGst)
  } else if (headerTotal !== null && headerSubtotal !== null && headerGst === null) {
    headerGst = round2(headerTotal - headerSubtotal)
  }

  // ── Reconcile lines to header subtotal, OR fall back to per-line ──
  let subtotal: number
  let totalTax: number
  let totalAmount: number

  const initialLineSum = round2(billLines.reduce((s, l) => s + l.Total, 0))

  if (headerTotal !== null && headerGst !== null && headerSubtotal !== null) {
    // STRICT PATH — header values present and reconciled. Bill MUST match.
    const lineDelta = round2(headerSubtotal - initialLineSum)

    if (lineDelta !== 0) {
      if (Math.abs(lineDelta) > MAX_LINE_NUDGE) {
        // Genuine extraction error — refuse to post rather than silently
        // dump $X onto the largest line.
        throw new Error(
          `Cannot post: line items sum to $${initialLineSum.toFixed(2)} but PDF header subtotal is $${headerSubtotal.toFixed(2)} (delta $${lineDelta.toFixed(2)}). Edit the line items to match the invoice subtotal before approving.`
        )
      }
      // Within nudge tolerance — adjust largest line so the line sum
      // exactly equals the header subtotal.
      let maxIdx = 0
      for (let i = 1; i < billLines.length; i++) {
        if (Math.abs(billLines[i].Total) > Math.abs(billLines[maxIdx].Total)) maxIdx = i
      }
      billLines[maxIdx].Total = round2(billLines[maxIdx].Total + lineDelta)
      const adjustedLineSum = round2(billLines.reduce((s, l) => s + l.Total, 0))
      console.log(`AP ${invoiceId}: nudged line ${maxIdx} (${billLines[maxIdx].Description.substring(0, 40)}) by ${lineDelta.toFixed(2)} — line sum now ${adjustedLineSum.toFixed(2)} matches header subtotal ${headerSubtotal.toFixed(2)}`)
    }

    // Recompute tax MYOB-style: per-line round2(Total × rate) then sum.
    // We were previously trusting headerGst here, but MYOB independently
    // recalculates tax per line — if the PDF's gst line happened to use
    // a different rounding (whole-bill 10% vs sum-of-rounded-lines), the
    // submitted TotalTax/TotalAmount would disagree with MYOB's internal
    // computation by 1c. Submitting MYOB's own calc keeps the envelope
    // and the line-level GL entries consistent.
    subtotal    = headerSubtotal
    totalTax    = round2(billLines.reduce((s, l, idx) => s + round2(l.Total * lineRates[idx]), 0))
    totalAmount = round2(subtotal + totalTax)
    if (Math.abs(totalAmount - headerTotal) >= 0.01) {
      console.warn(`AP ${invoiceId}: MYOB-style total $${totalAmount.toFixed(2)} differs from PDF header total $${headerTotal.toFixed(2)} by $${(totalAmount - headerTotal).toFixed(2)}. Using MYOB-style — this is the value MYOB will accept and store.`)
    }
  } else {
    // FALLBACK — no header values to reconcile against. Compute totals
    // using MYOB's own per-line round-then-sum method so our envelope
    // matches what MYOB will recalc internally.
    const computedTax = round2(billLines.reduce((s, l, idx) => {
      return s + round2(l.Total * lineRates[idx])
    }, 0))
    subtotal    = initialLineSum
    totalTax    = computedTax
    totalAmount = round2(subtotal + totalTax)
    console.log(`AP ${invoiceId}: no PDF header totals — using computed subtotal ${subtotal.toFixed(2)}, tax ${totalTax.toFixed(2)}, total ${totalAmount.toFixed(2)} (per-line method).`)
  }

  // Credit note → flip every line + envelope total to negative. Reconciliation
  // above runs against the positive numbers from the PDF (those are what
  // Amanda sees), so the negation happens once at the end and the line/header
  // math stays consistent. MYOB UI does the same when you enter a bill with
  // negative quantities/amounts as a supplier credit.
  if (isCreditNote) {
    for (const l of billLines) l.Total = round2(-l.Total)
    subtotal    = round2(-subtotal)
    totalTax    = round2(-totalTax)
    totalAmount = round2(-totalAmount)
    console.log(`AP ${invoiceId}: credit note — posting bill with negative totals (subtotal ${subtotal.toFixed(2)}, total ${totalAmount.toFixed(2)})`)
  }

  const freightAmount = 0

  const memoParts = [
    `${isCreditNote ? 'AP CREDIT' : 'AP'}: ${inv.vendor_name_parsed || 'Vendor'} — ${inv.invoice_number}`,
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

  // ── Step 2.5: apply payment if requested (best effort) ──
  // When the AP invoice has payment_account_uid set, immediately post a
  // Purchase/PaymentTxn against the new bill so it doesn't sit on the
  // payables ledger. Used for Capricorn-routed invoices and similar
  // where the supplier balance is settled via a clearing account.
  // Failures are recorded on myob_payment_error but DON'T fail the bill
  // post — the bill is real in MYOB regardless.
  let paymentUid: string | null = null
  let paymentAppliedAt: string | null = null
  let paymentError: string | null = null

  // Apply payment when an account is set and the bill has a non-zero
  // total. Negative totalAmount = credit note → MYOB SupplierPayment with
  // negative Amount, which is the "Pay Refund" workflow that credits the
  // clearing account.
  if (safeBillUid && inv.payment_account_uid && totalAmount !== 0) {
    try {
      const memo = `${isCreditNote ? 'Auto-refund' : 'Auto-payment'} ${inv.via_capricorn ? '(Capricorn)' : ''} — ${inv.invoice_number || 'AP'}`.trim()
      const r = await applyBillPayment({
        connId:         conn.id,
        cfId:           conn.company_file_id,
        date:           inv.invoice_date,
        fromAccountUid: String(inv.payment_account_uid),
        supplierUid:    String(inv.resolved_supplier_uid),
        billUid:        safeBillUid,
        amount:         totalAmount,
        memo,
        performedBy:    postedBy,
      })
      paymentUid = r.paymentUid
      paymentAppliedAt = new Date().toISOString()
    } catch (e: any) {
      paymentError = (e?.message || String(e)).substring(0, 500)
      console.error(`AP ${invoiceId}: bill posted (UID ${safeBillUid}) but payment apply failed: ${paymentError}`)
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
    // Payment-side fields (NULL when payment wasn't requested)
    myob_payment_uid:        paymentUid,
    myob_payment_applied_at: paymentAppliedAt,
    myob_payment_error:      paymentError,
  }
  // Combine bill-side and payment-side errors into the existing column.
  const noteParts: string[] = []
  if (attachmentStatus === 'failed')  noteParts.push(`PDF attach failed: ${attachmentError}`)
  if (attachmentStatus === 'skipped') noteParts.push(`Bill posted: ${attachmentError}`)
  if (paymentError)                   noteParts.push(`Payment apply failed: ${paymentError}`)
  postUpdate.myob_post_error = noteParts.length > 0 ? noteParts.join(' · ') : null

  await c.from('ap_invoices').update(postUpdate).eq('id', invoiceId)

  // ── Step 4: record line→account history for future smart-pickup ──
  // Best-effort: failures are logged but never fail the post. Each line is
  // recorded with the account that was actually used (per-line override
  // wins over invoice-level resolved_account_uid). Lines without a valid
  // account+description are skipped inside recordPostedLineHistory.
  try {
    await recordPostedLineHistory(c, {
      supplier_uid:      String(inv.resolved_supplier_uid),
      supplier_name:     inv.resolved_supplier_name || null,
      myob_company_file: companyFile,
      lines: lines.map((l: any) => ({
        description:  String(l.description || ''),
        account_uid:  String(l.account_uid || inv.resolved_account_uid || ''),
        account_code: String(l.account_code || inv.resolved_account_code || ''),
        account_name: String(l.account_name || ''),
      })).filter((l: any) => l.account_uid && l.description),
    })
  } catch (e: any) {
    console.error(`recordPostedLineHistory for ${invoiceId} failed: ${e?.message}`)
  }

  let paymentStatus: 'applied' | 'failed' | 'skipped' = 'skipped'
  if (paymentUid) paymentStatus = 'applied'
  else if (paymentError) paymentStatus = 'failed'

  return {
    ok: true,
    myobBillUid: safeBillUid || '',
    myobBillRowId,
    attachmentStatus,
    attachmentError,
    paymentStatus,
    paymentUid,
    paymentError: paymentError || undefined,
  }
}

// ── Spend Money path (no-supplier invoices) ────────────────────────────
//
// Mirrors createServiceBill but POSTs to /Banking/SpendMoneyTxn — used
// when an invoice doesn't have a MYOB supplier mapped. The invoice's
// payment_account_uid is the "from" account (where money is paid out
// of, e.g. a bank account or clearing), each line debits its expense
// account directly, and there's no follow-up payment txn since the
// SpendMoney transaction IS the payment.
//
// PDF attaches to /Banking/SpendMoneyTxn/{uid}/Attachment (same shape).
//
// Limitations (deliberate):
//   - Credit notes aren't handled here — those need ReceiveMoneyTxn,
//     which is a separate endpoint with the opposite money flow. If a
//     no-supplier credit note needs posting today, the user should
//     either assign a supplier or handle it directly in MYOB.
//   - No idempotency adopt — there's no SupplierInvoiceNumber on
//     SpendMoney to query against, so a retry could create a duplicate.
//     Approve is one-shot; client-side idempotency check still applies
//     (status !== 'posted' guard at the API layer).

export interface CreateSpendMoneyTxnResult {
  ok: true
  myobTxnUid: string
  attachmentStatus: 'attached' | 'failed' | 'skipped' | 'no-pdf'
  attachmentError?: string
}

interface SpendMoneyLineBody {
  Description: string
  Account: { UID: string }
  Amount: number
  TaxCode: { UID: string }
}

interface SpendMoneyBody {
  Date: string
  Account: { UID: string }     // FROM account (bank / clearing)
  Memo: string
  IsTaxInclusive: boolean
  Lines: SpendMoneyLineBody[]
  Subtotal: number
  TotalTax: number
  TotalAmount: number
}

export async function createSpendMoneyTxn(
  invoiceId: string,
  postedBy: string,
): Promise<CreateSpendMoneyTxnResult> {
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
  if (inv.is_credit_note === true) {
    throw new Error('No-supplier credit notes need ReceiveMoneyTxn — handle in MYOB or assign a supplier card.')
  }
  if (!inv.payment_account_uid) {
    throw new Error('Spend Money requires a clearing/bank account — tick "Mark as paid" with an account first.')
  }
  if (!inv.invoice_date) throw new Error('Invoice date is required to post')

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

  // Build SpendMoney lines + capture rates for downstream tax math.
  const txnLines: SpendMoneyLineBody[] = []
  const lineRates: number[] = []
  for (const l of lines) {
    const description = [l.part_number, l.description].filter(Boolean).join(' — ').substring(0, 255)
    const lineAmount = round2(Number(l.line_total_ex_gst || 0))
    const accountUid: string = l.account_uid || inv.resolved_account_uid
    txnLines.push({
      Description: description || 'AP line',
      Account: { UID: accountUid },
      Amount: lineAmount,
      TaxCode: { UID: taxUidFor(l.tax_code) },
    })
    lineRates.push(rateFor(l.tax_code))
  }

  // ── Reconcile lines to PDF header subtotal (same logic as createServiceBill) ──
  // NOTE: duplicated from createServiceBill's reconciliation block. If this
  // diverges or grows, factor into a shared helper.
  const headerTotalRaw    = inv.total_inc_gst    != null && Number.isFinite(Number(inv.total_inc_gst))    ? Number(inv.total_inc_gst)    : null
  const headerGstRaw      = inv.gst_amount       != null && Number.isFinite(Number(inv.gst_amount))       ? Number(inv.gst_amount)       : null
  const headerSubtotalRaw = inv.subtotal_ex_gst  != null && Number.isFinite(Number(inv.subtotal_ex_gst))  ? Number(inv.subtotal_ex_gst)  : null
  const headerTotal    = headerTotalRaw    !== null ? round2(headerTotalRaw)    : null
  let   headerGst      = headerGstRaw      !== null ? round2(headerGstRaw)      : null
  let   headerSubtotal = headerSubtotalRaw !== null ? round2(headerSubtotalRaw) : null
  if (headerTotal !== null && headerGst !== null && headerSubtotal !== null) {
    const impliedTotal = round2(headerSubtotal + headerGst)
    const internalDelta = round2(headerTotal - impliedTotal)
    if (Math.abs(internalDelta) > HEADER_CONSISTENCY_TOLERANCE) {
      console.warn(`AP-SM ${invoiceId}: header values inconsistent — trusting total + gst, re-deriving subtotal.`)
      headerSubtotal = round2(headerTotal - headerGst)
    }
  } else if (headerTotal !== null && headerGst !== null && headerSubtotal === null) {
    headerSubtotal = round2(headerTotal - headerGst)
  } else if (headerTotal !== null && headerSubtotal !== null && headerGst === null) {
    headerGst = round2(headerTotal - headerSubtotal)
  }

  const initialLineSum = round2(txnLines.reduce((s, l) => s + l.Amount, 0))
  let subtotal: number, totalTax: number, totalAmount: number
  if (headerTotal !== null && headerGst !== null && headerSubtotal !== null) {
    const lineDelta = round2(headerSubtotal - initialLineSum)
    if (lineDelta !== 0) {
      if (Math.abs(lineDelta) > MAX_LINE_NUDGE) {
        throw new Error(
          `Cannot post: line items sum to $${initialLineSum.toFixed(2)} but PDF header subtotal is $${headerSubtotal.toFixed(2)} (delta $${lineDelta.toFixed(2)}). Edit the line items to match the invoice subtotal before approving.`
        )
      }
      let maxIdx = 0
      for (let i = 1; i < txnLines.length; i++) {
        if (Math.abs(txnLines[i].Amount) > Math.abs(txnLines[maxIdx].Amount)) maxIdx = i
      }
      txnLines[maxIdx].Amount = round2(txnLines[maxIdx].Amount + lineDelta)
    }
    // Recompute tax MYOB-style — see same comment in createServiceBill.
    // Submitting PDF's headerGst would disagree with MYOB's per-line
    // recalculation by 1c when the PDF rounded GST whole-bill vs per-line.
    subtotal    = headerSubtotal
    totalTax    = round2(txnLines.reduce((s, l, idx) => s + round2(l.Amount * lineRates[idx]), 0))
    totalAmount = round2(subtotal + totalTax)
    if (Math.abs(totalAmount - headerTotal) >= 0.01) {
      console.warn(`AP ${invoiceId} (SpendMoney): MYOB-style total $${totalAmount.toFixed(2)} differs from PDF header total $${headerTotal.toFixed(2)} by $${(totalAmount - headerTotal).toFixed(2)}. Using MYOB-style.`)
    }
  } else {
    const computedTax = round2(txnLines.reduce((s, l, idx) => s + round2(l.Amount * lineRates[idx]), 0))
    subtotal    = initialLineSum
    totalTax    = computedTax
    totalAmount = round2(subtotal + totalTax)
  }

  const memoParts = [
    `AP (Spend Money): ${inv.vendor_name_parsed || 'Vendor'}${inv.invoice_number ? ' — ' + inv.invoice_number : ''}`,
  ]
  if (inv.linked_job_number) memoParts.push(`Job ${inv.linked_job_number}`)
  const journalMemo = memoParts.join(' — ').substring(0, 255)

  const body: SpendMoneyBody = {
    Date: inv.invoice_date,
    Account: { UID: String(inv.payment_account_uid) },
    Memo: journalMemo,
    IsTaxInclusive: false,
    Lines: txnLines,
    Subtotal: subtotal,
    TotalTax: totalTax,
    TotalAmount: totalAmount,
  }

  const path = `/accountright/${conn.company_file_id}/Banking/SpendMoneyTxn`
  const attemptsSoFar = (inv.myob_post_attempts || 0) + 1

  let result: { status: number; data: any; raw: string; headers: Record<string, string> }
  try {
    result = await myobFetch(conn.id, path, { method: 'POST', body, performedBy: postedBy })
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
    throw new Error(`MYOB rejected the spend-money txn (HTTP ${result.status}): ${errMsg}`)
  }

  const txnUid = extractMyobUid(result)
  const safeTxnUid = (txnUid && txnUid !== conn.company_file_id) ? txnUid : null

  // Attach PDF (best effort)
  let attachmentStatus: 'attached' | 'failed' | 'skipped' | 'no-pdf' = 'skipped'
  let attachmentError: string | undefined
  if (!safeTxnUid) {
    attachmentStatus = 'skipped'
    attachmentError = `No txn UID returned — cannot attach PDF`
  } else if (!inv.pdf_storage_path) {
    attachmentStatus = 'no-pdf'
  } else {
    try {
      await attachPdfToSpendMoney({
        connId: conn.id,
        cfId: conn.company_file_id,
        txnUid: safeTxnUid,
        pdfStoragePath: inv.pdf_storage_path,
        filename: inv.pdf_filename || `${inv.invoice_number || 'spend-money'}.pdf`,
        postedBy,
      })
      attachmentStatus = 'attached'
    } catch (e: any) {
      attachmentStatus = 'failed'
      attachmentError = (e?.message || String(e)).substring(0, 400)
      console.error(`SpendMoney ${safeTxnUid} posted but attachment failed:`, attachmentError)
    }
  }

  await c.from('ap_invoices').update({
    myob_bill_uid:       safeTxnUid || null,
    myob_txn_type:       'spend_money',
    myob_posted_at:      new Date().toISOString(),
    myob_posted_by:      postedBy,
    myob_post_attempts:  attemptsSoFar,
    status:              'posted',
    myob_post_error:     attachmentStatus === 'failed' ? `Posted but PDF attach failed: ${attachmentError}` : null,
    // Spend Money is the payment too — clear payment-side fields to avoid
    // confusion with the bill+payment flow.
    myob_payment_uid:        null,
    myob_payment_applied_at: null,
    myob_payment_error:      null,
  }).eq('id', invoiceId)

  return {
    ok: true,
    myobTxnUid: safeTxnUid || '',
    attachmentStatus,
    attachmentError,
  }
}

async function attachPdfToSpendMoney(opts: {
  connId: string
  cfId: string
  txnUid: string
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
    throw new Error(`PDF too large (${Math.round(arrayBuf.byteLength / 1024)}KB) — MYOB limit ${Math.round(MAX_ATTACHMENT_BYTES / 1024)}KB`)
  }
  const buffer = Buffer.from(arrayBuf)
  const base64 = buffer.toString('base64')
  const safeName = (opts.filename || 'invoice.pdf').replace(/[^\x20-\x7E]/g, '_').substring(0, 100)

  const path = `/accountright/${opts.cfId}/Banking/SpendMoneyTxn/${opts.txnUid}/Attachment`
  const result = await myobFetch(opts.connId, path, {
    method: 'POST',
    body: { Attachments: [{ OriginalFileName: safeName, FileBase64Content: base64 }] },
    performedBy: opts.postedBy,
  })
  if (result.status >= 400) {
    throw new Error(`MYOB rejected attachment (HTTP ${result.status}): ${extractMyobError(result)}`)
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