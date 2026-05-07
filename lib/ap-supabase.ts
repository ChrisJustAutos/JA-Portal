// lib/ap-supabase.ts
// Database helpers for the AP Invoice Processor.
//
// Centralises all Supabase reads/writes for the AP feature so route
// handlers stay thin. Each function uses the service-role client.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { ExtractedAPInvoice, ExtractedAPLineItem } from './ap-extraction'
import { attemptAutoLink, writeJobLink } from './ap-job-link'
import { tryAutoMatchSupplier } from './ap-myob-automatch'
import type { CompanyFileLabel } from './ap-myob-lookup'
import { resolveAllLinesForInvoice } from './ap-line-resolver'

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

const GST_RATE = 0.10
// $0.10 absolute tolerance for line-sum reconciliation. Tight enough to
// catch real arithmetic discrepancies, loose enough to absorb the standard
// per-line rounding to cents that vendor invoices accumulate.
const LINE_SUM_TOLERANCE = 0.10

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

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
      vendor_email:            e.vendor.email,
      vendor_phone:            e.vendor.phone,
      vendor_website:          e.vendor.website,
      vendor_street:           e.vendor.street,
      vendor_city:             e.vendor.city,
      vendor_state:            e.vendor.state,
      vendor_postcode:         e.vendor.postcode,
      vendor_country:          e.vendor.country,
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
  hasResolvedSupplier: boolean
  hasResolvedAccount: boolean
  exactDuplicateOf: string | null
  amountDuplicates: string[]
  poCheckStatus: 'matched' | 'unmatched' | 'no-po-on-invoice'
}

export function triageInvoice(input: TriageInput): TriageOutcome {
  const reasons: string[] = []
  const e = input.extracted

  if (!e.invoiceNumber) reasons.push('RED:missing-invoice-number')
  if (e.totals.totalIncGst === null) reasons.push('RED:missing-total')
  if (e.parseConfidence === 'low') reasons.push('RED:low-parse-confidence')
  if (input.exactDuplicateOf) reasons.push(`RED:duplicate-of:${input.exactDuplicateOf}`)
  if (e.lineItems.length === 0) reasons.push('RED:no-line-items')

  if (reasons.some(r => r.startsWith('RED:'))) {
    return { triageStatus: 'red', triageReasons: reasons }
  }

  if (!input.hasResolvedSupplier) {
    reasons.push('YELLOW:supplier-not-mapped')
  } else if (!input.hasResolvedAccount) {
    reasons.push('YELLOW:account-not-mapped')
  }

  if (e.parseConfidence === 'medium') reasons.push('YELLOW:medium-parse-confidence')
  if (!e.invoiceDate) reasons.push('YELLOW:missing-invoice-date')

  if (input.poCheckStatus === 'unmatched') {
    reasons.push('YELLOW:po-no-job-match')
  }

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
  if (e.totals.subtotalExGst !== null && Math.abs(lineSum - e.totals.subtotalExGst) > LINE_SUM_TOLERANCE) {
    reasons.push('YELLOW:line-sum-mismatch')
  }

  if (reasons.some(r => r.startsWith('YELLOW:'))) {
    return { triageStatus: 'yellow', triageReasons: reasons }
  }

  return { triageStatus: 'green', triageReasons: [] }
}

// ── Inc-GST line auto-correction ────────────────────────────────────────

interface LineRowCorrection {
  id: string
  tax_code: string | null
  line_total_ex_gst: number | string | null
  unit_price_ex_gst: number | string | null
}

interface AutoCorrectionResult {
  applied: boolean
  reason?: string
  before: { lineSum: number; subtotal: number | null; total: number | null }
  after?:  { lineSum: number }
}

async function maybeAutoCorrectIncGstLines(
  invoiceId: string,
  invoice: { subtotal_ex_gst: any; total_inc_gst: any },
  lines: LineRowCorrection[],
): Promise<AutoCorrectionResult> {
  const subtotalEx = invoice.subtotal_ex_gst !== null && invoice.subtotal_ex_gst !== undefined
    ? Number(invoice.subtotal_ex_gst) : null
  const totalInc = invoice.total_inc_gst !== null && invoice.total_inc_gst !== undefined
    ? Number(invoice.total_inc_gst) : null

  const lineSum = round2(lines.reduce((s, l) => s + Number(l.line_total_ex_gst || 0), 0))
  const before = { lineSum, subtotal: subtotalEx, total: totalInc }

  if (subtotalEx === null || totalInc === null || lines.length === 0) {
    return { applied: false, before }
  }

  if (Math.abs(totalInc - subtotalEx) < 0.01) {
    return { applied: false, before }
  }

  const matchesSubtotal = Math.abs(lineSum - subtotalEx) <= LINE_SUM_TOLERANCE
  const matchesTotalInc = Math.abs(lineSum - totalInc)   <= LINE_SUM_TOLERANCE

  if (matchesSubtotal) return { applied: false, before }
  if (!matchesTotalInc) return { applied: false, before }

  const c = sb()
  let mutated = 0

  for (const l of lines) {
    const code = (l.tax_code || 'GST').toUpperCase()
    if (code !== 'GST') continue

    const oldLine = Number(l.line_total_ex_gst || 0)
    const newLine = round2(oldLine / (1 + GST_RATE))
    const oldUnit = l.unit_price_ex_gst === null || l.unit_price_ex_gst === undefined || l.unit_price_ex_gst === ''
      ? null : Number(l.unit_price_ex_gst)
    const newUnit = oldUnit !== null ? round4(oldUnit / (1 + GST_RATE)) : null

    const update: Record<string, any> = { line_total_ex_gst: newLine }
    if (newUnit !== null) update.unit_price_ex_gst = newUnit

    const { error } = await c.from('ap_invoice_lines').update(update).eq('id', l.id)
    if (error) {
      console.error(`auto-correct line ${l.id} failed: ${error.message}`)
      continue
    }

    l.line_total_ex_gst = newLine
    if (newUnit !== null) l.unit_price_ex_gst = newUnit
    mutated++
  }

  if (mutated === 0) {
    return { applied: false, before, reason: 'no GST-coded lines to correct' }
  }

  const newLineSum = round2(lines.reduce((s, l) => s + Number(l.line_total_ex_gst || 0), 0))
  return {
    applied: true,
    reason: `Lines were inc-GST; ${mutated} line${mutated === 1 ? '' : 's'} divided by ${(1 + GST_RATE).toFixed(2)}`,
    before,
    after: { lineSum: newLineSum },
  }
}

// ── Duplicate detection ────────────────────────────────────────────────

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
  if (invoiceNumber) q = q.neq('invoice_number', invoiceNumber)

  const { data, error } = await q
  if (error) {
    console.error('findAmountDuplicates error:', error.message)
    return []
  }
  return (data || []).map((r: any) => r.id)
}

// ── Apply triage + supplier resolution + auto job link + line resolver ──

/**
 * Resolves an invoice's supplier+account mapping, runs PO→job auto-link,
 * runs triage, runs the smart per-line account resolver, and writes
 * everything back.
 *
 * Order:
 *   1. Auto-correct inc-GST lines if detected (mutates lines in place)
 *   2. Resolve invoice-level supplier/account (preset → MYOB auto-match)
 *   3. PO→job auto-link (skipped if linked manually)
 *   4. Run triage
 *   5. Persist invoice-level state
 *   6. Run line-account resolver — populates per-line account_uid OR
 *      suggested_account_uid based on rules + history. Skips lines whose
 *      account_source = 'manual'. See lib/ap-line-resolver.ts.
 *
 * Failures in non-critical steps (auto-match, line resolver) are logged
 * and don't break the parse pipeline.
 */
export async function applyTriageAndResolve(invoiceId: string): Promise<void> {
  const c = sb()
  const { data: inv, error } = await c
    .from('ap_invoices')
    .select('*')
    .eq('id', invoiceId)
    .single()
  if (error || !inv) throw new Error(`ap_invoices not found: ${invoiceId}`)

  const { data: linesRaw } = await c
    .from('ap_invoice_lines')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('line_no', { ascending: true })

  const lines: any[] = linesRaw || []

  const correction = await maybeAutoCorrectIncGstLines(
    invoiceId,
    { subtotal_ex_gst: inv.subtotal_ex_gst, total_inc_gst: inv.total_inc_gst },
    lines as LineRowCorrection[],
  )

  const extracted: ExtractedAPInvoice = {
    vendor: {
      name:     inv.vendor_name_parsed,
      abn:      inv.vendor_abn,
      email:    inv.vendor_email    ?? null,
      phone:    inv.vendor_phone    ?? null,
      website:  inv.vendor_website  ?? null,
      street:   inv.vendor_street   ?? null,
      city:     inv.vendor_city     ?? null,
      state:    inv.vendor_state    ?? null,
      postcode: inv.vendor_postcode ?? null,
      country:  inv.vendor_country  ?? null,
    },
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
    lineItems: lines.map((l: any) => ({
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

  const preset = await findSupplierMatch(extracted.vendor.name, extracted.vendor.abn)

  let resolvedSupplierUid:  string | null = preset?.myobSupplierUid    || null
  let resolvedSupplierName: string | null = preset?.myobSupplierName   || null
  let resolvedAccountUid:   string | null = preset?.defaultAccountUid  || null
  let resolvedAccountCode:  string | null = preset?.defaultAccountCode || null

  const companyFile: CompanyFileLabel =
    (preset?.myobCompanyFile as CompanyFileLabel | undefined) ||
    ((inv.myob_company_file as CompanyFileLabel | null) || 'VPS')

  if (!resolvedSupplierUid) {
    try {
      const auto = await tryAutoMatchSupplier(
        extracted.vendor.name,
        extracted.vendor.abn,
        companyFile,
      )
      if (auto) {
        resolvedSupplierUid  = auto.supplier.uid
        resolvedSupplierName = auto.supplier.name
        if (auto.supplier.defaultExpenseAccount) {
          resolvedAccountUid  = auto.supplier.defaultExpenseAccount.uid
          resolvedAccountCode = auto.supplier.defaultExpenseAccount.displayId
        }
      }
    } catch (e: any) {
      console.error(`auto-match failed for invoice ${invoiceId}:`, e?.message)
    }
  }

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
    extracted,
    hasResolvedSupplier: !!resolvedSupplierUid,
    hasResolvedAccount:  !!resolvedAccountUid,
    exactDuplicateOf, amountDuplicates,
    poCheckStatus,
  })

  if (correction.applied) {
    triage.triageReasons.push(`INFO:auto-corrected-inc-gst-lines:${correction.reason || ''}`.replace(/[\r\n]+/g, ' '))
  }

  // Persistent override: when triage_override='green', force the effective
  // status. Surface the original natural status + reasons in INFO: lines so
  // the audit trail is visible on the invoice. Override does NOT bypass RED:
  // a hard error (missing total, dup-of, etc.) cannot be silenced.
  let effectiveStatus = triage.triageStatus
  let effectiveReasons = triage.triageReasons
  if (inv.triage_override === 'green' && triage.triageStatus !== 'red') {
    const reasonText = (inv.triage_override_reason || '').replace(/[\r\n]+/g, ' ').trim()
    const overrideTrail = [
      `INFO:override-applied:was-${triage.triageStatus}`,
      ...(reasonText ? [`INFO:override-reason:${reasonText}`] : []),
      ...triage.triageReasons.filter(r => r.startsWith('YELLOW:')).map(r => 'INFO:overridden-' + r.toLowerCase()),
      ...triage.triageReasons.filter(r => !r.startsWith('YELLOW:')),
    ]
    effectiveStatus = 'green'
    effectiveReasons = overrideTrail
  }

  await c
    .from('ap_invoices')
    .update({
      resolved_supplier_uid:  resolvedSupplierUid,
      resolved_supplier_name: resolvedSupplierName,
      resolved_account_uid:   resolvedAccountUid,
      resolved_account_code:  resolvedAccountCode,
      myob_company_file:      companyFile,
      triage_status:          effectiveStatus,
      triage_reasons:         effectiveReasons,
      status:                 'pending_review',
    })
    .eq('id', invoiceId)

  // ── Step 6: smart per-line account resolution ──
  // Runs after the supplier is set, so the resolver has the right context.
  // Skips lines with account_source='manual' to preserve user picks. Logs
  // and continues on failure — line resolution is non-critical.
  try {
    await resolveAllLinesForInvoice(c, invoiceId)
  } catch (e: any) {
    console.error(`resolveAllLinesForInvoice failed for ${invoiceId}: ${e?.message}`)
  }
}
