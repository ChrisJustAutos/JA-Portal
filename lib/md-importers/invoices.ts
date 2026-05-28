// lib/md-importers/invoices.ts
//
// Multi-role importer for historical invoices. Three sheets:
//
//   • header   — one row per invoice. Subtotal/GST/total, status, customer.
//   • items    — line items. Each row carries the external invoice ID so we
//                can attach it to the right header.
//   • payments — payments. Each row carries the external invoice ID + amount.
//
// All three roles share the same External Invoice ID — that's the join key.
// Items + payments are optional; you can import header-only by skipping them.

import { SupabaseClient } from '@supabase/supabase-js'
import { ImportField, ImportTypeConfig, MappedRow, MultiRoleRows } from './types'

const str = (v: any) => (v == null ? '' : String(v).trim())
const numOr = (v: any, d: number) => { const n = Number(v); return isFinite(n) ? n : d }
const normSku = (v: any) => String(v || '').trim().toUpperCase()

// ── Header role ──────────────────────────────────────────────────────────────
const HEADER_FIELDS: ImportField[] = [
  { id: 'md_id',          label: 'External Invoice ID', aliases: ['Invoice ID', 'InvoiceID', 'Invoice Number', 'Number', 'External ID'], required: true, hint: 'Unique ID for this invoice in your source system — used to attach items + payments' },
  { id: 'customer_md_id', label: 'Customer (external ID)', aliases: ['Customer ID', 'CustomerID'], hint: 'Attaches the invoice to a customer imported earlier' },
  { id: 'status',         label: 'Status',              aliases: ['Status', 'Payment Status'] },
  { id: 'subtotal',       label: 'Subtotal ex GST',     aliases: ['Subtotal', 'Sub Total', 'Subtotal Ex GST'] },
  { id: 'gst',            label: 'GST',                 aliases: ['GST', 'Tax'] },
  { id: 'total',          label: 'Total inc GST',       aliases: ['Total', 'Grand Total', 'Total Inc GST'] },
  { id: 'invoice_date',   label: 'Invoice date',        aliases: ['Date', 'Invoice Date', 'Issue Date'] },
  { id: 'due_date',       label: 'Due date',            aliases: ['Due Date', 'Due', 'Date Due'] },
]

// ── Items role ───────────────────────────────────────────────────────────────
const ITEM_FIELDS: ImportField[] = [
  { id: 'invoice_md_id',  label: 'External Invoice ID', aliases: ['Invoice ID', 'InvoiceID', 'Invoice Number', 'Number'], required: true, hint: 'Matches a header imported in this same upload' },
  { id: 'md_id',          label: 'External Line ID',    aliases: ['Line ID', 'Item ID'], hint: 'Optional — dedupes line items on re-import' },
  { id: 'description',    label: 'Description',         aliases: ['Description', 'Details', 'Item'] },
  { id: 'part_number',    label: 'SKU',                 aliases: ['Stock Number', 'SKU', 'Part Number', 'Code'] },
  { id: 'qty',            label: 'Quantity',            aliases: ['Quantity', 'Qty'] },
  { id: 'unit_price',     label: 'Unit price',          aliases: ['Unit Price', 'Price'] },
  { id: 'included_gst',   label: 'Inc GST?',            aliases: ['Included GST', 'Inc GST', 'GST Inclusive'], hint: 'Y/N — converts inc-GST prices to ex-GST' },
  { id: 'line_type',      label: 'Line type',           aliases: ['Type', 'Line Type'], hint: 'labour / part / sublet / fee — inferred from SKU if blank' },
]

// ── Payments role ────────────────────────────────────────────────────────────
const PAYMENT_FIELDS: ImportField[] = [
  { id: 'invoice_md_id',  label: 'External Invoice ID', aliases: ['Invoice ID', 'InvoiceID', 'Invoice Number'], required: true, hint: 'Matches a header imported in this same upload' },
  { id: 'md_id',          label: 'External Payment ID', aliases: ['Payment ID', 'Transaction ID'], hint: 'Optional — dedupes on re-import' },
  { id: 'amount',         label: 'Amount',              aliases: ['Amount', 'Paid', 'Payment'], required: true },
  { id: 'tender',         label: 'Tender',              aliases: ['Tender', 'Type', 'Method'], hint: 'cash / eftpos / bank / cheque / etc' },
  { id: 'method',         label: 'Method',              aliases: ['Method', 'Reference', 'Notes'] },
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
  const headers = (data.header || []).map(r => ({
    md_id: str(r.md_id),
    customer_md_id: str(r.customer_md_id) || null,
    status: str(r.status) || 'open',
    subtotal: numOr(r.subtotal, 0),
    gst: numOr(r.gst, 0),
    total: numOr(r.total, 0),
    invoice_date: r.invoice_date || null,
    due_date: r.due_date || null,
  })).filter(r => r.md_id)

  const items = (data.items || []).map(r => {
    const inc = String(r.included_gst || '').toUpperCase() === 'Y'
    const unit = numOr(r.unit_price, 0)
    const ex = inc ? Math.round(unit / 1.1 * 10000) / 10000 : unit
    const stock = str(r.part_number)
    const desc = str(r.description)
    return {
      md_id: str(r.md_id) || null,
      invoice_md_id: str(r.invoice_md_id),
      description: desc || null,
      part_number: stock || null,
      qty: numOr(r.qty, 1),
      unit_price_ex_gst: ex,
      gst_rate: inc ? 0.10 : 0,
      total_ex_gst: Math.round(numOr(r.qty, 1) * ex * 100) / 100,
      line_type: str(r.line_type).toLowerCase() || inferLineType(stock, desc),
    }
  }).filter(r => r.invoice_md_id)

  const payments = (data.payments || []).map(r => ({
    md_id: str(r.md_id) || null,
    invoice_md_id: str(r.invoice_md_id),
    amount: numOr(r.amount, 0),
    tender: (str(r.tender) || 'cash').toLowerCase(),
    method: str(r.method) || null,
    payment_date: r.payment_date || null,
  })).filter(r => r.invoice_md_id && r.amount !== 0)

  return {
    rows: { header: headers, items, payments },
    summary: {
      headers: headers.length,
      items: items.length,
      payments: payments.length,
    },
  }
}

// ── Run: insert headers, then items + payments via md_id lookup ─────────────
async function run(db: SupabaseClient, data: MultiRoleRows): Promise<any> {
  const headers = data.header || []
  const items = data.items || []
  const payments = data.payments || []

  // 1. Lookup maps for customers (by md_id).
  const custMdToId = new Map<string, string>()
  for (let from = 0; ; from += 1000) {
    const { data: c } = await db.from('workshop_customers').select('id, md_id').not('md_id', 'is', null).range(from, from + 999)
    if (!c || c.length === 0) break
    for (const r of c) custMdToId.set((r as any).md_id, (r as any).id)
    if (c.length < 1000) break
  }

  // 2. Existing invoices by md_id so we don't double-insert headers + can
  //    find parent invoices for items/payments imported in earlier runs.
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
    payments_inserted: 0, payments_orphan: 0,
    errors: 0, first_error: null as string | null,
  }

  // 3. Insert new invoice headers in batches. Build md_id → id along the way.
  const newHeaders = [] as any[]
  const newHeaderMdIds = [] as string[]
  const seenHeaderMdIds = new Set<string>(invByMdId.keys())
  for (const h of headers) {
    if (seenHeaderMdIds.has(h.md_id)) { summary.headers_skipped++; continue }
    seenHeaderMdIds.add(h.md_id)
    const customer_id = h.customer_md_id ? custMdToId.get(h.customer_md_id) : null
    if (h.customer_md_id && !customer_id) summary.headers_no_customer++
    let dueIso: string | null = null
    if (h.due_date) { const d = new Date(h.due_date); if (!isNaN(d.getTime())) dueIso = d.toISOString() }
    let createdIso: string | null = null
    if (h.invoice_date) { const d = new Date(h.invoice_date); if (!isNaN(d.getTime())) createdIso = d.toISOString() }
    newHeaders.push({
      md_id: h.md_id, customer_id: customer_id || null, status: h.status,
      subtotal: h.subtotal, gst: h.gst, total: h.total, due_date: dueIso,
      ...(createdIso ? { created_at: createdIso } : {}),
    })
    newHeaderMdIds.push(h.md_id)
  }

  for (let i = 0; i < newHeaders.length; i += 500) {
    const batch = newHeaders.slice(i, i + 500)
    const mdIds = newHeaderMdIds.slice(i, i + 500)
    const { data: inserted, error } = await db.from('workshop_invoices').insert(batch).select('id, md_id')
    if (error) {
      summary.errors += batch.length
      if (!summary.first_error) summary.first_error = `invoice header batch @${i}: ${error.message}`
      continue
    }
    summary.headers_inserted += (inserted || []).length
    for (const r of inserted || []) invByMdId.set((r as any).md_id, (r as any).id)
    // Belt-and-braces: also map by the order we sent (in case the API returns
    // a subset). Postgres preserves insertion order under simple INSERT, so the
    // returned rows align with the input.
    for (let k = 0; k < (inserted || []).length; k++) {
      const md = (inserted as any)[k]?.md_id || mdIds[k]
      const id = (inserted as any)[k]?.id
      if (md && id) invByMdId.set(md, id)
    }
  }

  // 4. Inventory lookup for items so part lines can attach to stock.
  const invBySku = new Map<string, string>()
  if (items.length > 0) {
    for (let from = 0; ; from += 1000) {
      const { data: invs } = await db.from('workshop_inventory').select('id, sku').not('sku', 'is', null).range(from, from + 999)
      if (!invs || invs.length === 0) break
      for (const r of invs) { const k = normSku((r as any).sku); if (k && !invBySku.has(k)) invBySku.set(k, (r as any).id) }
      if (invs.length < 1000) break
    }
  }

  // 5. Items — attach to the parent invoice by md_id.
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
      sort_order: so, md_id: it.md_id,
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

  // 6. Payments — attach to the parent invoice. booking_id stays NULL.
  const paymentRows: any[] = []
  for (const p of payments) {
    const invoice_id = invByMdId.get(p.invoice_md_id)
    if (!invoice_id) { summary.payments_orphan++; continue }
    paymentRows.push({
      invoice_id, booking_id: null, amount: p.amount, tender: p.tender,
      method: p.method, posted_to_myob: false, md_id: p.md_id,
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
    { id: 'header',   label: 'Invoice headers',  sheets: ['Invoices', 'Invoice', 'Invoice Summaries'], fields: HEADER_FIELDS, required: true,  blurb: 'One row per invoice — totals, status, customer link.' },
    { id: 'items',    label: 'Invoice items',    sheets: ['Invoice Items', 'Items', 'Invoice Lines'],  fields: ITEM_FIELDS,   required: false, blurb: 'Optional — line items per invoice, joined by external invoice ID.' },
    { id: 'payments', label: 'Invoice payments', sheets: ['Payments', 'Invoice Payments'],             fields: PAYMENT_FIELDS, required: false, blurb: 'Optional — payments against invoices, joined by external invoice ID.' },
  ],
  normalize,
  run,
  blurb: 'Imports historical invoices. Pick the headers sheet (required), plus optional items + payments sheets — all joined by the external Invoice ID. Customers link by their external customer ID — make sure customers are imported first.',
}
