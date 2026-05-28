// lib/md-importers/invoices.ts
//
// Header-row import for invoices. Same shape as quotes — line items come in
// a follow-up phase.

import { SupabaseClient } from '@supabase/supabase-js'
import { ImportField, ImportTypeConfig, MappedRow } from './types'

const str = (v: any) => (v == null ? '' : String(v).trim())
const numOr = (v: any, d: number) => { const n = Number(v); return isFinite(n) ? n : d }

const FIELDS: ImportField[] = [
  { id: 'md_id',           label: 'MD Invoice ID',    aliases: ['Invoice ID', 'InvoiceID', 'Invoice Number', 'Number'], required: true },
  { id: 'customer_md_id',  label: 'Customer MD ID',   aliases: ['Customer ID', 'CustomerID'] },
  { id: 'status',          label: 'Status',           aliases: ['Status', 'Payment Status'] },
  { id: 'subtotal',        label: 'Subtotal ex GST',  aliases: ['Subtotal', 'Sub Total'] },
  { id: 'gst',             label: 'GST',              aliases: ['GST', 'Tax'] },
  { id: 'total',           label: 'Total inc GST',    aliases: ['Total', 'Grand Total', 'Total Inc GST'] },
  { id: 'due_date',        label: 'Due date',         aliases: ['Due Date', 'Due', 'Date Due'] },
]

function normalize(rows: MappedRow[]) {
  let skipped = 0
  const out: MappedRow[] = []
  for (const r of rows) {
    const mdId = str(r.md_id); if (!mdId) { skipped++; continue }
    out.push({
      md_id: mdId,
      customer_md_id: str(r.customer_md_id) || null,
      status: str(r.status) || 'open',
      subtotal: numOr(r.subtotal, 0),
      gst: numOr(r.gst, 0),
      total: numOr(r.total, 0),
      due_date: r.due_date || null,
    })
  }
  return { rows: out, summary: { total_in_file: rows.length, skipped: skipped, total_to_import: out.length } }
}

async function run(db: SupabaseClient, rows: MappedRow[]): Promise<any> {
  const custMdToId = new Map<string, string>()
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('workshop_customers').select('id, md_id').not('md_id', 'is', null).range(from, from + 999)
    if (!data || data.length === 0) break
    for (const r of data) custMdToId.set((r as any).md_id, (r as any).id)
    if (data.length < 1000) break
  }
  const existingMd = new Set<string>()
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('workshop_invoices').select('md_id').not('md_id', 'is', null).range(from, from + 999)
    if (!data || data.length === 0) break
    for (const r of data) existingMd.add((r as any).md_id)
    if (data.length < 1000) break
  }

  const inserts: any[] = []
  const summary = { inserted: 0, already_linked: 0, no_customer: 0, errors: 0 }
  for (const r of rows) {
    if (existingMd.has(r.md_id)) { summary.already_linked++; continue }
    const customer_id = r.customer_md_id ? custMdToId.get(r.customer_md_id) : null
    if (r.customer_md_id && !customer_id) summary.no_customer++
    let dueIso: string | null = null
    if (r.due_date) { const d = new Date(r.due_date); if (!isNaN(d.getTime())) dueIso = d.toISOString() }
    inserts.push({
      md_id: r.md_id, customer_id: customer_id || null, status: r.status,
      subtotal: r.subtotal, gst: r.gst, total: r.total, due_date: dueIso,
    })
  }
  for (let i = 0; i < inserts.length; i += 500) {
    const batch = inserts.slice(i, i + 500)
    const { error } = await db.from('workshop_invoices').insert(batch)
    if (error) { summary.errors += batch.length; continue }
    summary.inserted += batch.length
  }
  return summary
}

export const INVOICES_CONFIG: ImportTypeConfig = {
  id: 'invoices',
  label: 'Invoices',
  sheets: ['Invoices', 'Invoice'],
  fields: FIELDS,
  normalize,
  run,
  blurb: 'Header-only invoice import (no line items yet). Links to customers via MD Customer ID. Skips already-imported MD invoice IDs.',
}
