// lib/ap-supabase.ts
// Database helpers for the AP Invoice Processor.
//
// Centralises all Supabase reads/writes for the AP feature so route
// handlers stay thin. Each function uses the service-role client.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { ExtractedAPInvoice, ExtractedAPLineItem } from './ap-extraction'
import { attemptAutoLink, writeJobLink } from './ap-job-link'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const STORAGE_BUCKET = 'ap-invoices'
const SIGNED_URL_TTL_SEC = 60 * 60   // 1 hour for the UI's PDF preview

// Window for amount-based duplicate detection. A genuine duplicate is almost
// always within a few weeks of the original — wider windows produce false
// positives from coincidentally-equal totals on unrelated invoices.
const AMOUNT_DUP_WINDOW_DAYS = 30

// ── Insert parsed invoice + lines ───────────────────────────────────────

export interface InvoiceInsertInput {
  source: 'email' | 'upload'
  emailMessageId?: string | null
  emailFrom?: string | null
  emailSubject?: string | null
  pdfFilename: string
  extracted: ExtractedAPInvoice
  rawExtraction: any
}

export interface InsertedInvoice {
  id: string
  pdfStoragePath: string
}

export async function insertInvoiceWithLines(input: InvoiceInsertInput): Promise<InsertedInvoice> {
  const c = sb()
  const e = input.extracted

  const { data: row, error: err } = await c
    .from('ap_invoices')
    .insert({
      source:                  input.source,
      email_message_id:        input.emailMessageId || null,
      email_from:              input.emailFrom || null,
      email_subject:           input.emailSubject || null,
      pdf_filename:            input.pdfFilename,
      pdf_storage_path:        null,
      vendor_name_parsed:      e.vendor.name,
      vendor_abn:              e.vendor.abn,
      invoice_number:          e.invoiceNumber,
      invoice_date:            e.invoiceDate,
      po_number:               e.poNumber,
      due_date:                e.dueDate,
      subtotal_ex_gst:         e.totals.subtotalExGst,
      gst_amount:              e.totals.gstAmount,
      total_inc_gst:           e.totals.totalIncGst,
      via_capricorn:           e.capricorn.via,
      capricorn_reference:     e.capricorn.reference,
      capricorn_member_number: e.capricorn.memberNumber,
      notes:                   e.notes,
      raw_extraction:          input.rawExtraction,
      parse_confidence:        e.parseConfidence,
      status:                  'parsing',
    })
    .select('id')
    .single()

  if (err || !row) throw new Error(`ap_invoices insert failed: ${err?.message}`)

  const invoiceId = row.id as string
  const pdfStoragePath = `${invoiceId}.pdf`

  if (e.lineItems.length > 0) {
    const linesPayload = e.lineItems.map(li => ({
      invoice_id:        invoiceId,
      line_no:           li.lineNo,
      part_number:       li.partNumber,
      description:       li.description,
      qty:               li.qty,
      uom:               li.uom,
      unit_price_ex_gst: li.unitPriceExGst,
      line_total_ex_gst: li.lineTotalExGst ?? 0,
      gst_amount:        li.gstAmount,
      tax_code:          li.taxCode || 'GST',
    }))
    const { error: linesErr } = await c.from('ap_invoice_lines').insert(linesPayload)
    if (linesErr) {
      await c.from('ap_invoices').delete().eq('id', invoiceId)
      throw new Error(`ap_invoice_lines insert failed: ${linesErr.message}`)
    }
  }

  await c.from('ap_invoices').update({ pdf_storage_path: pdfStoragePath }).eq('id', invoiceId)

  return { id: invoiceId, pdfStoragePath }
}

// ── PDF storage ────────────────────────────────────────────────────────

export async function uploadInvoicePdf(pdfStoragePath: string, pdfBytes: Buffer): Promise<void> {
  const c = sb()
  const { error } = await c.storage
    .from(STORAGE_BUCKET)
    .upload(pdfStoragePath, pdfBytes, {
      contentType: 'application/pdf',
      upsert: true,
    })
  if (error) throw new Error(`PDF upload to ${pdfStoragePath} failed: ${error.message}`)
}

export async function getInvoicePdfSignedUrl(pdfStoragePath: string): Promise<string> {
  const c = sb()
  const { data, error } = await c.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(pdfStoragePath, SIGNED_URL_TTL_SEC)
  if (error || !data?.signedUrl) {
    throw new Error(`Could not sign URL for ${pdfStoragePath}: ${error?.message}`)
  }
  return data.signedUrl
}

/**
 * Best-effort delete of the PDF from storage. Logs and continues on failure
 * — the invoice row delete is the source of truth.
 */
export async function deleteInvoicePdf(pdfStoragePath: string): Promise<void> {
  const c = sb()
  try {
    const { error } = await c.storage.from(STORAGE_BUCKET).remove([pdfStoragePath])
    if (error) console.error(`PDF storage delete failed for ${pdfStoragePath}:`, error.message)
  } catch (e: any) {
    console.error(`PDF storage delete threw for ${pdfStoragePath}:`, e?.message)
  }
}

// ── Hard delete an invoice (cascades lines, removes PDF) ────────────────

export interface DeleteInvoiceResult {
  ok: true
  deleted: { id: string; pdfRemoved: boolean }
}

/**
 * Permanently removes an AP invoice, its lines (via FK cascade), and its
 * PDF from storage. Refuses if the invoice has been posted to MYOB —
 * posted bills must remain auditable; reject the bill in MYOB instead.
 */
export async function deleteInvoice(invoiceId: string): Promise<DeleteInvoiceResult> {
  const c = sb()

  const { data: inv, error: fetchErr } = await c
    .from('ap_invoices')
    .select('id, status, pdf_storage_path')
    .eq('id', invoiceId)
    .maybeSingle()

  if (fetchErr) throw new Error(`fetch before delete failed: ${fetchErr.message}`)
  if (!inv) throw new Error('NOT_FOUND')
  if (inv.status === 'posted') throw new Error('CANNOT_DELETE_POSTED')

  let pdfRemoved = false
  if (inv.pdf_storage_path) {
    await deleteInvoicePdf(inv.pdf_storage_path)
    pdfRemoved = true
  }

  const { error: delErr } = await c.from('ap_invoices').delete().eq('id', invoiceId)
  if (delErr) throw new Error(`delete failed: ${delErr.message}`)

  return { ok: true, deleted: { id: invoiceId, pdfRemoved } }
}

// ── Supplier lookup (preset account map) ────────────────────────────────

export interface SupplierMatch {
  id: string
  pattern: string
  myobSupplierUid: string
  myobSupplierName: string
  defaultAccountUid: string
  defaultAccountCode: string
  defaultAccountName: string | null
  myobCompanyFile: 'VPS' | 'JAWS'
  viaCapricorn: boolean
  autoApprove: boolean
}

export async function findSupplierMatch(
  vendorNameParsed: string | null,
  abn: string | null,
): Promise<SupplierMatch | null> {
  if (!vendorNameParsed && !abn) return null
  const c = sb()

  if (abn) {
    const { data } = await c
      .from('ap_supplier_account_map')
      .select('*')
      .eq('match_abn', abn)
      .limit(1)
      .maybeSingle()
    if (data) return mapRowToSupplier(data)
  }

  if (vendorNameParsed) {
    const upperVendor = vendorNameParsed.toUpperCase()
    const { data: rows } = await c
      .from('ap_supplier_account_map')
      .select('*')
      .order('supplier_match_pattern', { ascending: false })
    if (rows) {
      const matches = (rows as any[])
        .filter(r => upperVendor.includes(r.supplier_match_pattern.toUpperCase()))
        .sort((a, b) => b.supplier_match_pattern.length - a.supplier_match_pattern.length)
      if (matches.length > 0) return mapRowToSupplier(matches[0])
    }
  }

  return null
}

function mapRowToSupplier(r: any): SupplierMatch {
  return {
    id: r.id,
    pattern: r.supplier_match_pattern,
    myobSupplierUid: r.myob_supplier_uid,
    myobSupplierName: r.myob_supplier_name,
    defaultAccountUid: r.default_account_uid,
    defaultAccountCode: r.default_account_code,
    defaultAccountName: r.default_account_name,
    myobCompanyFile: r.myob_company_file,
    viaCapricorn: r.via_capricorn,
    autoApprove: r.auto_approve,
  }
}

// ── Triage logic ────────────────────────────────────────────────────────

export interface TriageOutcome {
  triageStatus: 'green' | 'yellow' | 'red'
  triageReasons: string[]
}

export interface TriageInput {
  extracted: ExtractedAPInvoice
  supplier: SupplierMatch | null
  exactDuplicateOf: string | null         // same vendor + same invoice_number
  amountDuplicates: string[]              // same vendor + same total within window
  poCheckStatus: 'matched' | 'unmatched' | 'no-po-on-invoice'
}

/**
 * Triage philosophy:
 * - 🟢 GREEN: parsed cleanly + supplier preset exists + totals reconcile +
 *             (PO matched a job OR no PO needed) + no duplicates
 * - 🟡 YELLOW: needs human eyes — new supplier, unmatched PO, totals off,
 *              low confidence, missing date, possible amount duplicate.
 * - 🔴 RED: cannot post — missing invoice number, missing total, parser
 *           unsure, exact duplicate, no line items.
 */
export function triageInvoice(input: TriageInput): TriageOutcome {
  const reasons: string[] = []
  const e = input.extracted

  // RED conditions
  if (!e.invoiceNumber) reasons.push('RED:missing-invoice-number')
  if (e.totals.totalIncGst === null) reasons.push('RED:missing-total')
  if (e.parseConfidence === 'low') reasons.push('RED:low-parse-confidence')
  if (input.exactDuplicateOf) reasons.push(`RED:duplicate-of:${input.exactDuplicateOf}`)
  if (e.lineItems.length === 0) reasons.push('RED:no-line-items')

  if (reasons.some(r => r.startsWith('RED:'))) {
    return { triageStatus: 'red', triageReasons: reasons }
  }

  // YELLOW conditions
  if (!input.supplier) reasons.push('YELLOW:supplier-not-mapped')
  if (e.parseConfidence === 'medium') reasons.push('YELLOW:medium-parse-confidence')
  if (!e.invoiceDate) reasons.push('YELLOW:missing-invoice-date')

  // PO check: only flag if PO was on the invoice but didn't match any job.
  // No-PO is normal for Capricorn-routed invoices — neutral, not a flag.
  if (input.poCheckStatus === 'unmatched') {
    reasons.push('YELLOW:po-no-job-match')
  }

  // Possible duplicate by amount — different invoice number but same vendor
  // and total within the recent window. Flag once per match (cap at 3 IDs
  // listed in reasons to keep them readable).
  if (input.amountDuplicates.length > 0) {
    const ids = input.amountDuplicates.slice(0, 3).join(',')
    reasons.push(`YELLOW:possible-duplicate-amount:${ids}`)
  }

  if (e.totals.subtotalExGst !== null && e.totals.gstAmount !== null && e.totals.totalIncGst !== null) {
    const reconciled = e.totals.subtotalExGst + e.totals.gstAmount
    if (Math.abs(reconciled - e.totals.totalIncGst) > 0.05) {
      reasons.push('YELLOW:totals-mismatch')
    }
  }

  const lineSum = e.lineItems.reduce((s, li) => s + (li.lineTotalExGst ?? 0), 0)
  if (e.totals.subtotalExGst !== null && Math.abs(lineSum - e.totals.subtotalExGst) > 0.10) {
    reasons.push('YELLOW:line-sum-mismatch')
  }

  if (reasons.some(r => r.startsWith('YELLOW:'))) {
    return { triageStatus: 'yellow', triageReasons: reasons }
  }

  return { triageStatus: 'green', triageReasons: [] }
}

// ── Duplicate detection ────────────────────────────────────────────────

/**
 * Exact duplicate: same vendor + same invoice number. This is a hard block —
 * no two genuine invoices ever share the exact (vendor, invoice number) pair.
 */
export async function findExactDuplicate(
  vendorNameParsed: string | null,
  invoiceNumber: string | null,
  excludeId?: string,
): Promise<string | null> {
  if (!vendorNameParsed || !invoiceNumber) return null
  const c = sb()
  let q = c
    .from('ap_invoices')
    .select('id')
    .eq('vendor_name_parsed', vendorNameParsed)
    .eq('invoice_number', invoiceNumber)
    .limit(1)
  if (excludeId) q = q.neq('id', excludeId)
  const { data } = await q.maybeSingle()
  return data?.id ?? null
}

/**
 * Amount-based duplicate detection: same vendor, same total (inc GST), within
 * the recent window (default 30 days), but DIFFERENT invoice number. Returns
 * matching invoice IDs (most recent first, capped). Returns [] when total is
 * null or no candidates exist.
 *
 * Real-world rationale: workshops sometimes get the same charge billed twice
 * with different invoice numbers (supplier credit/rebill, or a person uploads
 * a re-issued invoice that still describes the same goods). Same vendor, same
 * dollar amount, close in time = worth a second look.
 */
export async function findAmountDuplicates(
  vendorNameParsed: string | null,
  totalIncGst: number | null,
  invoiceNumber: string | null,
  excludeId?: string,
  windowDays: number = AMOUNT_DUP_WINDOW_DAYS,
): Promise<string[]> {
  if (!vendorNameParsed || totalIncGst === null) return []
  const c = sb()
  const sinceIso = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString()

  let q = c
    .from('ap_invoices')
    .select('id')
    .eq('vendor_name_parsed', vendorNameParsed)
    .eq('total_inc_gst', totalIncGst)
    .gte('received_at', sinceIso)
    .order('received_at', { ascending: false })
    .limit(5)
  if (excludeId) q = q.neq('id', excludeId)
  // If we know our own invoice number, exclude rows that share it (those are
  // the *exact* dup branch — don't double-flag the same row in two reasons).
  if (invoiceNumber) q = q.neq('invoice_number', invoiceNumber)

  const { data, error } = await q
  if (error) {
    console.error('findAmountDuplicates error:', error.message)
    return []
  }
  return (data || []).map((r: any) => r.id)
}

// ── Apply triage + supplier resolution + auto job link ──────────────────

export async function applyTriageAndResolve(invoiceId: string): Promise<void> {
  const c = sb()
  const { data: inv, error } = await c
    .from('ap_invoices')
    .select('*')
    .eq('id', invoiceId)
    .single()
  if (error || !inv) throw new Error(`ap_invoices not found: ${invoiceId}`)

  const { data: lines } = await c
    .from('ap_invoice_lines')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('line_no', { ascending: true })

  const extracted: ExtractedAPInvoice = {
    vendor: { name: inv.vendor_name_parsed, abn: inv.vendor_abn },
    invoiceNumber: inv.invoice_number,
    invoiceDate: inv.invoice_date,
    dueDate: inv.due_date,
    poNumber: inv.po_number,
    totals: {
      subtotalExGst: inv.subtotal_ex_gst !== null ? Number(inv.subtotal_ex_gst) : null,
      gstAmount: inv.gst_amount !== null ? Number(inv.gst_amount) : null,
      totalIncGst: inv.total_inc_gst !== null ? Number(inv.total_inc_gst) : null,
    },
    capricorn: {
      via: inv.via_capricorn,
      reference: inv.capricorn_reference,
      memberNumber: inv.capricorn_member_number,
    },
    notes: inv.notes,
    lineItems: (lines || []).map((l: any) => ({
      lineNo: l.line_no,
      partNumber: l.part_number,
      description: l.description,
      qty: l.qty !== null ? Number(l.qty) : null,
      uom: l.uom,
      unitPriceExGst: l.unit_price_ex_gst !== null ? Number(l.unit_price_ex_gst) : null,
      lineTotalExGst: l.line_total_ex_gst !== null ? Number(l.line_total_ex_gst) : null,
      gstAmount: l.gst_amount !== null ? Number(l.gst_amount) : null,
      taxCodeRaw: null,
      taxCode: l.tax_code,
    })),
    parseConfidence: (inv.parse_confidence || 'medium') as 'high' | 'medium' | 'low',
  }

  const supplier = await findSupplierMatch(extracted.vendor.name, extracted.vendor.abn)
  const exactDuplicateOf = await findExactDuplicate(
    extracted.vendor.name,
    extracted.invoiceNumber,
    invoiceId,
  )
  const amountDuplicates = await findAmountDuplicates(
    extracted.vendor.name,
    extracted.totals.totalIncGst,
    extracted.invoiceNumber,
    invoiceId,
  )

  // ── Auto-link to MD job by PO, but DON'T overwrite a manual link ──
  let poCheckStatus: 'matched' | 'unmatched' | 'no-po-on-invoice'
  if (inv.linked_job_match_method === 'manual' && inv.linked_job_number) {
    poCheckStatus = 'matched'
  } else {
    const auto = await attemptAutoLink(extracted.poNumber)
    poCheckStatus = auto.status
    await writeJobLink(
      invoiceId,
      auto.job?.job_number || null,
      'auto-po',
      auto.status,
    )
  }

  const triage = triageInvoice({
    extracted, supplier,
    exactDuplicateOf, amountDuplicates,
    poCheckStatus,
  })

  await c
    .from('ap_invoices')
    .update({
      resolved_supplier_uid:  supplier?.myobSupplierUid || null,
      resolved_supplier_name: supplier?.myobSupplierName || null,
      resolved_account_uid:   supplier?.defaultAccountUid || null,
      resolved_account_code:  supplier?.defaultAccountCode || null,
      myob_company_file:      supplier?.myobCompanyFile || 'VPS',
      triage_status:          triage.triageStatus,
      triage_reasons:         triage.triageReasons,
      status:                 'pending_review',
    })
    .eq('id', invoiceId)
}
