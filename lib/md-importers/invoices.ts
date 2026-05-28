// lib/md-importers/invoices.ts
//
// Multi-role importer for historical invoices.
//
// Roles:
//   • header   — Invoices Summary sheet. One row per invoice.
//   • items    — Invoice Items sheet(s). MD splits this across multiple
//                sheets when row count > 65k (XLS limit), so the items role
//                accepts more than one sheet — all picked sheets are
//                concatenated client-side using the same column mapping.
//   • payments — Invoice Payment sheet.
//
// All three roles share the External Invoice ID as the join key. Items +
// payments are optional. Notes-only rows (no Description, zero amount) on
// the items sheet are skipped — they're work-narrative carry-overs, not
// billable lines.

import { SupabaseClient } from '@supabase/supabase-js'
import { ImportField, ImportTypeConfig, MappedRow, MultiRoleRows } from './types'

const str = (v: any) => (v == null ? '' : String(v).trim())
const numOr = (v: any, d: number) => { const n = Number(v); return isFinite(n) ? n : d }
const normSku = (v: any) => String(v || '').trim().toUpperCase()

/** Convert an Excel date serial OR a DD/MM/YYYY string into an ISO date. */
function toIsoDate(v: any): string | null {
  if (v == null || v === '') return null
  if (typeof v === 'number' && isFinite(v)) {
    // Excel date serial (1900-based). 25569 = 1970-01-01 in the same epoch.
    const ms = (v - 25569) * 86400 * 1000
    const d = new Date(ms)
    return isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s) return null
    // DD/MM/YYYY or DD-MM-YYYY (Aussie)
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/)
    if (m) {
      const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])))
      return isNaN(d.getTime()) ? null : d.toISOString()
    }
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

// ── Header role ──────────────────────────────────────────────────────────────
const HEADER_FIELDS: ImportField[] = [
  { id: 'md_id',          label: 'External Invoice ID', aliases: ['Invoice Number', 'Invoice ID', 'InvoiceID', 'Number'], required: true, hint: 'Unique ID for this invoice — used to attach items + payments' },
  { id: 'customer_md_id', label: 'Customer (external ID)', aliases: ['Customer ID', 'CustomerID'], hint: 'Attaches the invoice to a customer imported earlier' },
  { id: 'finalized',      label: 'Finalized (Y/N)',     aliases: ['Finalized', 'Finalised', 'Status'], hint: 'Y → completed, otherwise open' },
  { id: 'subtotal',       label: 'Net amount (ex GST)', aliases: ['Net Amount', 'Subtotal', 'Sub Total'] },
  { id: 'gst',            label: 'GST',                 aliases: ['Tax Amount', 'GST', 'Tax'] },
  { id: 'total',          label: 'Total (inc GST)',     aliases: ['Total Amount', 'Total', 'Grand Total'] },
  { id: 'paid',           label: 'Amount paid',         aliases: ['Paid Amount', 'Paid'] },
  { id: 'invoice_date',   label: 'Issue date',          aliases: ['Issue Date', 'Date', 'Invoice Date'] },
  { id: 'due_date',       label: 'Due date',            aliases: ['Due Date', 'Due'] },
]

// ── Items role ───────────────────────────────────────────────────────────────
const ITEM_FIELDS: ImportField[] = [
  { id: 'invoice_md_id',  label: 'External Invoice ID', aliases: ['Invoice Number', 'Invoice ID', 'InvoiceID'], required: true, hint: 'Matches a header by the same External Invoice ID' },
  { id: 'description',    label: 'Description',         aliases: ['Description', 'Item', 'Stock Name'], hint: 'Falls back to Details/Stock Name if blank' },
  { id: 'details',        label: 'Details',             aliases: ['Details', 'Notes'], hint: 'Multi-line work narrative — used as fallback description' },
  { id: 'part_number',    label: 'SKU',                 aliases: ['Stock Number', 'SKU', 'Part Number', 'Code'] },
  { id: 'qty',            label: 'Quantity',            aliases: ['Quantity', 'Qty'] },
  { id: 'unit_price_ex',  label: 'Unit price (ex GST)', aliases: ['Unit Price', 'Price'], hint: 'MD exports ex-GST; if your file is inc-GST switch to the Net Amount column' },
  { id: 'net_amount',     label: 'Net amount (ex GST)', aliases: ['Net Amount'], hint: 'Optional override for total ex-GST per line' },
  { id: 'taxable',        label: 'Taxable (Y/N)',       aliases: ['Taxable', 'GST Applies'], hint: 'Y → GST rate 10%, N → 0%' },
]

// ── Payments role ────────────────────────────────────────────────────────────
const PAYMENT_FIELDS: ImportField[] = [
  { id: 'invoice_md_id',  label: 'External Invoice ID', aliases: ['Invoice Number', 'Invoice ID'], required: true },
  { id: 'md_id',          label: 'Payment number',      aliases: ['Payment Number', 'Payment ID', 'Transaction ID', 'Reference'], hint: 'Unique ID for dedupe on re-import' },
  { id: 'amount',         label: 'Amount',              aliases: ['Amount', 'Paid', 'Payment'], required: true },
  { id: 'tender',         label: 'Payment type',        aliases: ['Payment Type', 'Tender', 'Type', 'Method'], hint: 'cash / eftpos / bank / other' },
  { id: 'payment_date',   label: 'Payment date',        aliases: ['Date', 'Payment Date'] },
]

function inferLineType(stock: string, desc: string): 'labour' | 'part' | 'sublet' | 'fee' {
  const s = (String(stock || '') + ' ' + String(desc || '')).toUpperCase()
  if (/^LAB\b/.test(String(stock || '').toUpperCase()) || s.includes('LABOUR')) return 'labour'
  if (s.includes('SUBLET')) return 'sublet'
  if (s.includes('MISC') || s.includes('ENVIRO') || s.includes('FREIGHT') || s.includes('DISPOSAL')) return 'fee'
  return 'part'
}

// ── Normalize: per-role cleanup ──────────────────────────────────────────────
function normalize(data: MultiRoleRows): { rows: MultiRoleRows; summary: any } {
  const headers = (data.header || []).map(r => {
    const isFinalised = String(r.finalized || '').toUpperCase() === 'Y'
    return {
      md_id: str(r.md_id),
      customer_md_id: str(r.customer_md_id) || null,
      status: isFinalised ? 'finalised' : 'open',
      subtotal: numOr(r.subtotal, 0),
      gst: numOr(r.gst, 0),
      total: numOr(r.total, 0),
      paid: numOr(r.paid, 0),
      invoice_date: toIsoDate(r.invoice_date),
      due_date: toIsoDate(r.due_date),
    }
  }).filter(r => r.md_id)

  let itemsSkipped = 0
  const items = (data.items || []).map(r => {
    const desc = str(r.description) || str(r.details) || null
    const stock = str(r.part_number)
    const qty = numOr(r.qty, 0)
    const unit = numOr(r.unit_price_ex, 0)
    const net = numOr(r.net_amount, 0)
    // Total ex-GST per line: prefer mapped net_amount, else qty × unit_price.
    const totalEx = net !== 0 ? net : qty * unit
    const taxable = String(r.taxable || '').toUpperCase() !== 'N'  // default Y unless explicitly N
    return {
      invoice_md_id: str(r.invoice_md_id),
      description: desc,
      part_number: stock || null,
      qty: qty || 0,
      unit_price_ex_gst: unit,
      gst_rate: taxable ? 0.10 : 0,
      total_ex_gst: Math.round(totalEx * 100) / 100,
      line_type: inferLineType(stock, desc || ''),
    }
  }).filter(r => {
    if (!r.invoice_md_id) { itemsSkipped++; return false }
    // Skip notes-only rows (Description blank or zero-value carry-overs).
    if ((r.qty || 0) === 0 && (r.unit_price_ex_gst || 0) === 0 && (r.total_ex_gst || 0) === 0) { itemsSkipped++; return false }
    return true
  })

  const payments = (data.payments || []).map(r => ({
    md_id: str(r.md_id) || null,
    invoice_md_id: str(r.invoice_md_id),
    amount: numOr(r.amount, 0),
    tender: (str(r.tender) || 'cash').toLowerCase(),
    payment_date: toIsoDate(r.payment_date),
  })).filter(r => r.invoice_md_id && r.amount !== 0)

  return {
    rows: { header: headers, items, payments },
    summary: {
      headers: headers.length,
      items: items.length,
      items_skipped_notes: itemsSkipped,
      payments: payments.length,
    },
  }
}

// ── Run: insert headers, then items + payments via md_id lookup ─────────────
async function run(db: SupabaseClient, data: MultiRoleRows): Promise<any> {
  const headers = data.header || []
  const items = data.items || []
  const payments = data.payments || []

  // 1. Customer md_id → id map.
  const custMdToId = new Map<string, string>()
  for (let from = 0; ; from += 1000) {
    const { data: c } = await db.from('workshop_customers').select('id, md_id').not('md_id', 'is', null).range(from, from + 999)
    if (!c || c.length === 0) break
    for (const r of c) custMdToId.set((r as any).md_id, (r as any).id)
    if (c.length < 1000) break
  }

  // 2. Existing invoices by md_id (so we don't double-insert + so we can find
  //    parent invoices for items/payments from later runs).
  const invByMdId = new Map<string, string>()
  for (let from = 0; ; from += 1000) {
    const { data: i } = await db.from('workshop_invoices').select('id, md_id').not('md_id', 'is', null).range(from, from + 999)
    if (!i || i.length === 0) break
    for (const r of i) invByMdId.set((r as any).md_id, (r as any).id)
    if (i.length < 1000) break
  }

  const summary: any = {
    headers_inserted: 0, headers_skipped: 0, headers_no_customer: 0,
    items_inserted: 0, items_orphan: 0,
    payments_inserted: 0, payments_orphan: 0, payments_dup: 0,
    errors: 0, first_error: null as string | null,
  }

  // 3. Insert new invoice headers in batches. Dedupe within file by md_id.
  const newHeaders: any[] = []
  const seenHeaderMdIds = new Set<string>(invByMdId.keys())
  for (const h of headers) {
    if (seenHeaderMdIds.has(h.md_id)) { summary.headers_skipped++; continue }
    seenHeaderMdIds.add(h.md_id)
    const customer_id = h.customer_md_id ? custMdToId.get(h.customer_md_id) : null
    if (h.customer_md_id && !customer_id) summary.headers_no_customer++
    newHeaders.push({
      md_id: h.md_id, customer_id: customer_id || null, status: h.status,
      subtotal: h.subtotal, gst: h.gst, total: h.total, due_date: h.due_date,
      ...(h.invoice_date ? { created_at: h.invoice_date } : {}),
    })
  }
  for (let i = 0; i < newHeaders.length; i += 500) {
    const batch = newHeaders.slice(i, i + 500)
    const { data: inserted, error } = await db.from('workshop_invoices').insert(batch).select('id, md_id')
    if (error) {
      summary.errors += batch.length
      if (!summary.first_error) summary.first_error = `invoice header batch @${i}: ${error.message}`
      continue
    }
    summary.headers_inserted += (inserted || []).length
    for (const r of inserted || []) invByMdId.set((r as any).md_id, (r as any).id)
  }

  // 4. Inventory SKU → id map for items.
  const invBySku = new Map<string, string>()
  if (items.length > 0) {
    for (let from = 0; ; from += 1000) {
      const { data: invs } = await db.from('workshop_inventory').select('id, sku').not('sku', 'is', null).range(from, from + 999)
      if (!invs || invs.length === 0) break
      for (const r of invs) { const k = normSku((r as any).sku); if (k && !invBySku.has(k)) invBySku.set(k, (r as any).id) }
      if (invs.length < 1000) break
    }
  }

  // 5. Items — attach to parent invoice by md_id.
  const sortByInvoice = new Map<string, number>()
  const itemRows: any[] = []
  for (const it of items) {
    const invoice_id = invByMdId.get(it.invoice_md_id)
    if (!invoice_id) { summary.items_orphan++; continue }
    const so = sortByInvoice.get(invoice_id) || 0
    sortByInvoice.set(invoice_id, so + 1)
    itemRows.push({
      invoice_id, line_type: it.line_type, description: it.description,
      part_number: it.part_number, qty: it.qty, unit_price_ex_gst: it.unit_price_ex_gst,
      gst_rate: it.gst_rate, total_ex_gst: it.total_ex_gst,
      inventory_id: it.part_number ? invBySku.get(normSku(it.part_number)) || null : null,
      sort_order: so,
    })
  }
  for (let i = 0; i < itemRows.length; i += 500) {
    const batch = itemRows.slice(i, i + 500)
    const { error } = await db.from('workshop_invoice_lines').insert(batch)
    if (error) {
      summary.errors += batch.length
      if (!summary.first_error) summary.first_error = `invoice items batch @${i}: ${error.message}`
      continue
    }
    summary.items_inserted += batch.length
  }

  // 6. Payments — match by invoice md_id, dedupe within file + against existing.
  const existingPaymentMdIds = new Set<string>()
  if (payments.some(p => p.md_id)) {
    for (let from = 0; ; from += 1000) {
      const { data: ps } = await db.from('workshop_payments').select('md_id').not('md_id', 'is', null).range(from, from + 999)
      if (!ps || ps.length === 0) break
      for (const r of ps) existingPaymentMdIds.add((r as any).md_id)
      if (ps.length < 1000) break
    }
  }
  const paymentRows: any[] = []
  const seenPaymentMdIds = new Set<string>()
  for (const p of payments) {
    if (p.md_id) {
      if (existingPaymentMdIds.has(p.md_id) || seenPaymentMdIds.has(p.md_id)) { summary.payments_dup++; continue }
      seenPaymentMdIds.add(p.md_id)
    }
    const invoice_id = invByMdId.get(p.invoice_md_id)
    if (!invoice_id) { summary.payments_orphan++; continue }
    paymentRows.push({
      invoice_id, booking_id: null, amount: p.amount, tender: p.tender,
      posted_to_myob: false, md_id: p.md_id,
    })
  }
  for (let i = 0; i < paymentRows.length; i += 500) {
    const batch = paymentRows.slice(i, i + 500)
    const { error } = await db.from('workshop_payments').insert(batch)
    if (error) {
      summary.errors += batch.length
      if (!summary.first_error) summary.first_error = `payments batch @${i}: ${error.message}`
      continue
    }
    summary.payments_inserted += batch.length
  }

  return summary
}

export const INVOICES_CONFIG: ImportTypeConfig = {
  id: 'invoices',
  label: 'Invoices',
  roles: [
    { id: 'header',   label: 'Invoice headers',  sheets: ['Invoices Summary', 'Invoices', 'Invoice', 'Invoice Summaries'], fields: HEADER_FIELDS, required: true,  blurb: 'One row per invoice — totals, status, customer link, dates.' },
    { id: 'items',    label: 'Invoice items',    sheets: ['Invoice Items', 'Items', 'Invoice Lines'],                       fields: ITEM_FIELDS,   required: false, blurb: 'Line items per invoice, joined by external Invoice ID. If MD split your items across multiple sheets (XLS 65k row limit), add all of them here — they share the same column mapping.' },
    { id: 'payments', label: 'Invoice payments', sheets: ['Invoice Payment', 'Payments', 'Invoice Payments'],               fields: PAYMENT_FIELDS, required: false, blurb: 'Payments against invoices, joined by external Invoice ID. Deduped by Payment Number across the file + against existing payments.' },
  ],
  normalize,
  run,
  blurb: 'Historical invoices. Pick the Invoices Summary sheet (required) + optional items + payments. Customers link by their external customer ID — import customers first.',
}
