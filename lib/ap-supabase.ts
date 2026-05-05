// lib/ap-supabase.ts
// Database helpers for the AP Invoice Processor.
//
// Centralises all Supabase reads/writes for the AP feature so route
// handlers stay thin. Each function uses the service-role client.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { ExtractedAPInvoice, ExtractedAPLineItem } from './ap-extraction'

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

// ── Insert parsed invoice + lines ───────────────────────────────────────

export interface InvoiceInsertInput {
  source: 'email' | 'upload'
  emailMessageId?: string | null
  emailFrom?: string | null
  emailSubject?: string | null
  pdfFilename: string
  extracted: ExtractedAPInvoice
  rawExtraction: any                 // store the raw model output for debugging
}

export interface InsertedInvoice {
  id: string
  pdfStoragePath: string             // caller still needs to upload the bytes
}

export async function insertInvoiceWithLines(input: InvoiceInsertInput): Promise<InsertedInvoice> {
  const c = sb()
  const e = input.extracted

  // Storage path is keyed off the new id — generate first via uuid.
  // We let Postgres assign the id by inserting and reading back the row.
  const { data: row, error: err } = await c
    .from('ap_invoices')
    .insert({
      source:                  input.source,
      email_message_id:        input.emailMessageId || null,
      email_from:              input.emailFrom || null,
      email_subject:           input.emailSubject || null,
      pdf_filename:            input.pdfFilename,
      pdf_storage_path:        null,                  // set after upload
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

  // Insert line items
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
      // Roll back the header insert so we don't leave orphans
      await c.from('ap_invoices').delete().eq('id', invoiceId)
      throw new Error(`ap_invoice_lines insert failed: ${linesErr.message}`)
    }
  }

  // Set pdf_storage_path now that we know the path; caller uploads bytes after.
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

/**
 * Find the supplier-to-account mapping for a parsed vendor name.
 * Matches via case-insensitive substring against supplier_match_pattern,
 * preferring the longest pattern (so "BURSON AUTO PARTS" beats "AUTO" if
 * both are configured).
 *
 * Returns null when no preset exists — caller should leave the invoice
 * unresolved and surface yellow status with "supplier preset missing".
 */
export async function findSupplierMatch(
  vendorNameParsed: string | null,
  abn: string | null,
): Promise<SupplierMatch | null> {
  if (!vendorNameParsed && !abn) return null
  const c = sb()

  // ABN match wins if we have one
  if (abn) {
    const { data } = await c
      .from('ap_supplier_account_map')
      .select('*')
      .eq('match_abn', abn)
      .limit(1)
      .maybeSingle()
    if (data) return mapRowToSupplier(data)
  }

  // Otherwise try pattern match (case-insensitive, longest pattern wins)
  if (vendorNameParsed) {
    const upperVendor = vendorNameParsed.toUpperCase()
    const { data: rows } = await c
      .from('ap_supplier_account_map')
      .select('*')
      .order('supplier_match_pattern', { ascending: false })  // not perfect but rough longest-first
    if (rows) {
      // Filter to substring matches, then sort by pattern length desc
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

/**
 * Apply triage rules to a parsed invoice + supplier match outcome.
 * Returns the colour and human-readable reason codes.
 *
 * Triage philosophy:
 * - 🟢 GREEN: parsed cleanly + supplier preset exists + totals reconcile
 * - 🟡 YELLOW: connected to MYOB-actionable state but needs human eyes
 *              (new supplier, totals slightly off, low confidence parse)
 * - 🔴 RED:    cannot post without intervention
 *              (missing invoice number, missing total, parser unsure,
 *              duplicate of existing invoice)
 */
export interface TriageInput {
  extracted: ExtractedAPInvoice
  supplier: SupplierMatch | null
  duplicateOf: string | null    // existing invoice id with same vendor+number, or null
}

export function triageInvoice(input: TriageInput): TriageOutcome {
  const reasons: string[] = []
  const e = input.extracted

  // ── RED conditions ──
  if (!e.invoiceNumber) reasons.push('RED:missing-invoice-number')
  if (e.totals.totalIncGst === null) reasons.push('RED:missing-total')
  if (e.parseConfidence === 'low') reasons.push('RED:low-parse-confidence')
  if (input.duplicateOf) reasons.push(`RED:duplicate-of:${input.duplicateOf}`)
  if (e.lineItems.length === 0) reasons.push('RED:no-line-items')

  if (reasons.some(r => r.startsWith('RED:'))) {
    return { triageStatus: 'red', triageReasons: reasons }
  }

  // ── YELLOW conditions ──
  if (!input.supplier) reasons.push('YELLOW:supplier-not-mapped')
  if (e.parseConfidence === 'medium') reasons.push('YELLOW:medium-parse-confidence')
  if (!e.invoiceDate) reasons.push('YELLOW:missing-invoice-date')

  // Totals reconcile check: subtotal + gst should equal total (within $0.05)
  if (e.totals.subtotalExGst !== null && e.totals.gstAmount !== null && e.totals.totalIncGst !== null) {
    const reconciled = e.totals.subtotalExGst + e.totals.gstAmount
    if (Math.abs(reconciled - e.totals.totalIncGst) > 0.05) {
      reasons.push('YELLOW:totals-mismatch')
    }
  }

  // Sum of line totals vs subtotal (within $0.10 to allow rounding)
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

export async function findDuplicateInvoice(
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

// ── Apply triage + supplier resolution to an invoice row ────────────────

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

  // Reconstruct ExtractedAPInvoice shape from the row for triage()
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
  const duplicateOf = await findDuplicateInvoice(
    extracted.vendor.name,
    extracted.invoiceNumber,
    invoiceId,
  )

  const triage = triageInvoice({ extracted, supplier, duplicateOf })

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
