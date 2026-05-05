// lib/ap-statement-match.ts
// Compare extracted statement lines against MYOB Purchase Bills and the
// portal's ap_invoices table. Used by /api/ap/statement/match.
//
// Strategy:
//   1. Determine the date window for MYOB lookups: from min(line dates) -
//      14 days to max(line dates) + 14 days. Falls back to a 90-day
//      window ending today if line dates are missing.
//   2. Pull all Purchase/Bill/Service AND Purchase/Bill/Item bills for
//      the supplier UID in that window. MYOB OData doesn't expose
//      Supplier/UID for filtering, so we filter by Date in OData and
//      then narrow to Supplier.UID in JS. Pagination via $skip + $top.
//   3. Index by SupplierInvoiceNumber (case-insensitive, trimmed). Build
//      a parallel index from ap_invoices for "in portal but not yet
//      posted" detection.
//   4. For each statement line of type 'invoice':
//        - Look up MYOB bill by invoice number
//        - Compare amount (tolerance: $0.05 absolute) and date (tolerance:
//          7 days)
//        - Cross-reference portal state if no MYOB match
//        - Emit a MatchResult with status + deltas
//   5. Identify "orphans" — MYOB bills that exist in the period for this
//      supplier but aren't on the statement. Useful for spotting bills
//      mistakenly attributed.
//
// LIMITATIONS:
//   - Tolerance windows are heuristics. A 14-day-old credit-note re-issue
//     against a 2-month-old invoice would be flagged as date-mismatch.
//   - Match is exact on invoice number after normalisation (uppercase,
//     trimmed, leading zeros stripped, '-' and '/' removed). Suppliers
//     occasionally print sub-references on the statement that differ
//     subtly from the actual invoice number (e.g. INV-1234A on the
//     statement vs INV-1234 in MYOB). Those will show as missing — user
//     can spot-check.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExtractedStatement, ExtractedStatementLine } from './ap-statement-extraction'
import { getConnection, myobFetch } from './myob'
import type { CompanyFileLabel } from './ap-myob-lookup'

const AMOUNT_TOLERANCE = 0.05
const DATE_TOLERANCE_DAYS = 7
const MYOB_PAGE_SIZE = 400  // MYOB API caps at 400 per page

// ── Types ───────────────────────────────────────────────────────────────

export type MatchStatus =
  | 'matched'             // MYOB bill found, amount and date within tolerance
  | 'amount-mismatch'     // MYOB bill found but amount differs > tolerance
  | 'date-mismatch'       // MYOB bill found, amount OK, but date differs > tolerance
  | 'in-portal-pending'   // Not in MYOB but exists in portal (pending review/ready/error)
  | 'rejected-in-portal'  // In portal but rejected
  | 'missing'             // No trace anywhere
  | 'skipped'             // Statement line is not an invoice (payment/credit/unknown)

export interface MyobBillSummary {
  uid: string
  number: string | null              // MYOB-issued bill number (e.g. "00020051")
  date: string | null
  totalAmount: number | null
  supplierInvoiceNumber: string | null
}

export interface PortalInvoiceSummary {
  id: string
  status: string
  invoiceNumber: string | null
  invoiceDate: string | null
  totalIncGst: number | null
  myobBillUid: string | null
}

export interface MatchResult {
  line: ExtractedStatementLine
  status: MatchStatus
  myobBill: MyobBillSummary | null
  portalInvoice: PortalInvoiceSummary | null
  amountDelta: number | null         // myob.totalAmount - line.amount
  dateDeltaDays: number | null       // myob.date - line.date
  notes: string | null
}

export interface OrphanBill extends MyobBillSummary {
  reason: 'in-myob-not-on-statement'
}

export interface MatchSummary {
  total: number
  invoiceLines: number
  matched: number
  amountMismatch: number
  dateMismatch: number
  missing: number
  inPortalPending: number
  rejected: number
  skipped: number
  orphans: number
}

export interface StatementMatchOutcome {
  results: MatchResult[]
  orphans: OrphanBill[]
  summary: MatchSummary
  windowFrom: string
  windowTo: string
  myobBillCount: number
  myobBillCountForSupplier: number
}

// ── Public entry point ──────────────────────────────────────────────────

export async function matchStatementAgainstMyob(
  c: SupabaseClient,
  companyFile: CompanyFileLabel,
  supplierUid: string,
  statement: ExtractedStatement,
): Promise<StatementMatchOutcome> {
  const { from, to } = computeWindow(statement)

  // ── MYOB pull ──
  const conn = await getConnection(companyFile)
  if (!conn) throw new Error(`No active MYOB connection for ${companyFile}`)
  if (!conn.company_file_id) throw new Error(`MYOB connection ${companyFile} has no company file selected`)

  const allBills = await fetchAllBillsInRange(conn.id, conn.company_file_id, from, to)
  const supplierBills = allBills.filter(b => b.supplierUid === supplierUid)

  // Build index by normalised supplier invoice number
  const myobIndex = new Map<string, MyobBillSummary>()
  for (const b of supplierBills) {
    const key = normaliseInvoiceNumber(b.summary.supplierInvoiceNumber)
    if (!key) continue
    // First write wins — MYOB shouldn't have dupes per supplier+invNum
    // but if it does, the first one matches.
    if (!myobIndex.has(key)) myobIndex.set(key, b.summary)
  }

  // ── Portal index ──
  const portalIndex = await loadPortalIndexBySupplier(c, supplierUid)

  // ── Per-line matching ──
  const results: MatchResult[] = []
  const matchedMyobUids = new Set<string>()

  for (const line of statement.lines) {
    if (line.type !== 'invoice' || !line.invoiceNumber) {
      results.push({
        line,
        status: 'skipped',
        myobBill: null,
        portalInvoice: null,
        amountDelta: null,
        dateDeltaDays: null,
        notes: line.type !== 'invoice'
          ? `Statement line is type=${line.type}, not an invoice`
          : 'Invoice line has no invoice number',
      })
      continue
    }

    const key = normaliseInvoiceNumber(line.invoiceNumber)!
    const myobBill = myobIndex.get(key) || null
    const portalInvoice = portalIndex.get(key) || null

    if (myobBill) {
      matchedMyobUids.add(myobBill.uid)
      const result = compareMyobToStatement(line, myobBill, portalInvoice)
      results.push(result)
    } else if (portalInvoice) {
      // Not in MYOB but in our portal — flag based on its status
      let status: MatchStatus
      let notes: string
      if (portalInvoice.status === 'rejected') {
        status = 'rejected-in-portal'
        notes = `Invoice was rejected in the portal — supplier still has it on the statement`
      } else if (portalInvoice.status === 'posted') {
        // Portal says posted but MYOB doesn't have a matching SupplierInvoiceNumber.
        // Likely a UID stale on our side or the bill was deleted in MYOB.
        status = 'missing'
        notes = `Portal says posted (UID ${portalInvoice.myobBillUid?.substring(0, 8) || '?'}…) but MYOB has no matching bill for this supplier+invoice — was it deleted in MYOB?`
      } else {
        status = 'in-portal-pending'
        notes = `In portal as ${portalInvoice.status} — not yet pushed to MYOB`
      }
      results.push({
        line, status,
        myobBill: null,
        portalInvoice,
        amountDelta: null,
        dateDeltaDays: null,
        notes,
      })
    } else {
      results.push({
        line,
        status: 'missing',
        myobBill: null,
        portalInvoice: null,
        amountDelta: null,
        dateDeltaDays: null,
        notes: 'Not found in MYOB or in the portal — needs to be entered',
      })
    }
  }

  // ── Orphan detection ──
  const orphans: OrphanBill[] = supplierBills
    .filter(b => !matchedMyobUids.has(b.summary.uid))
    .map(b => ({ ...b.summary, reason: 'in-myob-not-on-statement' as const }))

  // ── Summary ──
  const summary: MatchSummary = {
    total: results.length,
    invoiceLines: results.filter(r => r.status !== 'skipped').length,
    matched:         results.filter(r => r.status === 'matched').length,
    amountMismatch:  results.filter(r => r.status === 'amount-mismatch').length,
    dateMismatch:    results.filter(r => r.status === 'date-mismatch').length,
    missing:         results.filter(r => r.status === 'missing').length,
    inPortalPending: results.filter(r => r.status === 'in-portal-pending').length,
    rejected:        results.filter(r => r.status === 'rejected-in-portal').length,
    skipped:         results.filter(r => r.status === 'skipped').length,
    orphans:         orphans.length,
  }

  return {
    results,
    orphans,
    summary,
    windowFrom: from,
    windowTo: to,
    myobBillCount: allBills.length,
    myobBillCountForSupplier: supplierBills.length,
  }
}

// ── Compare a single MYOB bill to a statement line ──────────────────────

function compareMyobToStatement(
  line: ExtractedStatementLine,
  myobBill: MyobBillSummary,
  portalInvoice: PortalInvoiceSummary | null,
): MatchResult {
  const stmtAmount = line.amount !== null ? Math.abs(line.amount) : null
  const myobAmount = myobBill.totalAmount
  const amountDelta =
    myobAmount !== null && stmtAmount !== null
      ? round2(myobAmount - stmtAmount)
      : null

  const dateDeltaDays =
    myobBill.date && line.date ? daysBetween(myobBill.date, line.date) : null

  let status: MatchStatus = 'matched'
  let notes: string | null = null

  if (amountDelta !== null && Math.abs(amountDelta) > AMOUNT_TOLERANCE) {
    status = 'amount-mismatch'
    notes = `Amount differs by ${formatMoney(amountDelta)} (statement ${formatMoney(stmtAmount)} vs MYOB ${formatMoney(myobAmount)})`
  } else if (dateDeltaDays !== null && Math.abs(dateDeltaDays) > DATE_TOLERANCE_DAYS) {
    status = 'date-mismatch'
    notes = `Date differs by ${dateDeltaDays} days (statement ${line.date} vs MYOB ${myobBill.date})`
  }

  return {
    line, status,
    myobBill, portalInvoice,
    amountDelta, dateDeltaDays, notes,
  }
}

// ── MYOB bill fetcher ───────────────────────────────────────────────────

interface BillRecord {
  supplierUid: string | null
  summary: MyobBillSummary
}

/**
 * Fetch all Service + Item Purchase Bills in a date range. Handles
 * MYOB OData pagination ($skip + $top). Returns a flat list with a
 * supplierUid per row so the caller can filter to the supplier of
 * interest.
 */
async function fetchAllBillsInRange(
  connId: string,
  cfId: string,
  fromIso: string,
  toIso: string,
): Promise<BillRecord[]> {
  const filter = `Date ge datetime'${fromIso}T00:00:00' and Date le datetime'${toIso}T23:59:59'`
  const out: BillRecord[] = []

  for (const billType of ['Service', 'Item']) {
    const path = `/accountright/${cfId}/Purchase/Bill/${billType}`
    let skip = 0
    // Hard cap iteration count as a safety net — at 400/page that's 4000
    // bills before we bail out, which would be unusual for a single supplier
    // even over a long window.
    for (let page = 0; page < 10; page++) {
      const result = await myobFetch(connId, path, {
        query: { '$filter': filter, '$top': MYOB_PAGE_SIZE, '$skip': skip },
      })
      if (result.status !== 200) {
        throw new Error(`MYOB ${billType} bill fetch failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 200)}`)
      }
      const items: any[] = Array.isArray(result.data?.Items) ? result.data.Items : []
      for (const it of items) {
        out.push({
          supplierUid: it?.Supplier?.UID || null,
          summary: {
            uid:                   String(it.UID || ''),
            number:                it.Number || null,
            date:                  typeof it.Date === 'string' ? it.Date.substring(0, 10) : null,
            totalAmount:           typeof it.TotalAmount === 'number' ? it.TotalAmount : null,
            supplierInvoiceNumber: it.SupplierInvoiceNumber || null,
          },
        })
      }
      if (items.length < MYOB_PAGE_SIZE) break
      skip += MYOB_PAGE_SIZE
    }
  }
  return out
}

// ── Portal-side index ───────────────────────────────────────────────────

async function loadPortalIndexBySupplier(
  c: SupabaseClient,
  supplierUid: string,
): Promise<Map<string, PortalInvoiceSummary>> {
  const { data, error } = await c
    .from('ap_invoices')
    .select('id, status, invoice_number, invoice_date, total_inc_gst, myob_bill_uid')
    .eq('resolved_supplier_uid', supplierUid)
    .not('invoice_number', 'is', null)
    .order('invoice_date', { ascending: false })
    .limit(500)

  if (error) {
    console.error('loadPortalIndexBySupplier error:', error.message)
    return new Map()
  }

  const idx = new Map<string, PortalInvoiceSummary>()
  for (const r of data || []) {
    const key = normaliseInvoiceNumber(r.invoice_number)
    if (!key) continue
    if (idx.has(key)) continue
    idx.set(key, {
      id:            r.id,
      status:        r.status,
      invoiceNumber: r.invoice_number,
      invoiceDate:   r.invoice_date,
      totalIncGst:   r.total_inc_gst !== null ? Number(r.total_inc_gst) : null,
      myobBillUid:   r.myob_bill_uid,
    })
  }
  return idx
}

// ── Helpers ─────────────────────────────────────────────────────────────

function computeWindow(statement: ExtractedStatement): { from: string; to: string } {
  const lineDates = statement.lines
    .map(l => l.date)
    .filter((d): d is string => !!d)
    .sort()
  let from: string
  let to: string
  if (lineDates.length > 0) {
    from = isoOffset(lineDates[0], -14)
    to   = isoOffset(lineDates[lineDates.length - 1], 14)
  } else if (statement.statementDate) {
    from = isoOffset(statement.statementDate, -90)
    to   = isoOffset(statement.statementDate, 14)
  } else {
    const today = new Date().toISOString().substring(0, 10)
    from = isoOffset(today, -90)
    to   = today
  }
  return { from, to }
}

function isoOffset(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().substring(0, 10)
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00Z').getTime()
  const db = new Date(b + 'T00:00:00Z').getTime()
  return Math.round((da - db) / (24 * 60 * 60 * 1000))
}

/**
 * Normalise an invoice number for matching. Statements and MYOB sometimes
 * write the same number with/without prefixes, leading zeros, hyphens, etc.
 * Strip to alphanumeric uppercase. Examples that should match:
 *   "INV-1234"   ↔  "inv1234"
 *   "0001234"    ↔  "1234"  (only when at least one is plain numeric)
 *   "00718992"   ↔  "00718992"
 * For pure-numeric values, also strip leading zeros so "00012" matches "12".
 */
export function normaliseInvoiceNumber(s: string | null | undefined): string | null {
  if (!s) return null
  const upper = String(s).toUpperCase().trim()
  const stripped = upper.replace(/[^0-9A-Z]/g, '')
  if (!stripped) return null
  // If pure numeric, strip leading zeros for fuzzy matching
  if (/^[0-9]+$/.test(stripped)) {
    const trimmed = stripped.replace(/^0+/, '')
    return trimmed || stripped  // edge case: "0000" → keep as "0000"
  }
  return stripped
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function formatMoney(n: number | null): string {
  if (n === null) return '$?'
  return `$${n.toFixed(2)}`
}
