// lib/md-importers/quotes.ts
//
// Header-row import for quotes. Line items will be a separate file/sheet in
// the next phase. Links to customers/vehicles via their md_id.

import { SupabaseClient } from '@supabase/supabase-js'
import { ImportField, ImportTypeConfig, MappedRow, MultiRoleRows } from './types'

const str = (v: any) => (v == null ? '' : String(v).trim())
const numOr = (v: any, d: number) => { const n = Number(v); return isFinite(n) ? n : d }
const normRego = (v: any) => String(v || '').replace(/\s+/g, '').toUpperCase()

const FIELDS: ImportField[] = [
  { id: 'md_id',            label: 'External Quote ID',  aliases: ['Quote ID', 'QuoteID', 'External ID', 'Number'], required: true, hint: 'Unique row ID from your source system' },
  { id: 'customer_md_id',   label: 'Customer (external ID)', aliases: ['Customer ID', 'CustomerID'], hint: 'Attaches the quote to a customer imported earlier' },
  { id: 'vehicle_rego',     label: 'Vehicle rego',     aliases: ['Rego', 'Vehicle Rego', 'Plate'] },
  { id: 'status',           label: 'Status',           aliases: ['Status', 'State'] },
  { id: 'subtotal',         label: 'Subtotal ex GST',  aliases: ['Subtotal', 'Sub Total', 'Sub-Total Ex GST'] },
  { id: 'gst',              label: 'GST',              aliases: ['GST', 'Tax'] },
  { id: 'total',            label: 'Total inc GST',    aliases: ['Total', 'Total Inc GST', 'Grand Total'] },
  { id: 'notes',            label: 'Notes',            aliases: ['Notes', 'Note', 'Description'] },
]

function normalizeMain(rows: MappedRow[]) {
  let skipped = 0
  const out: MappedRow[] = []
  for (const r of rows) {
    const mdId = str(r.md_id); if (!mdId) { skipped++; continue }
    out.push({
      md_id: mdId,
      customer_md_id: str(r.customer_md_id) || null,
      vehicle_rego: str(r.vehicle_rego) || null,
      status: str(r.status) || 'draft',
      subtotal: numOr(r.subtotal, 0),
      gst: numOr(r.gst, 0),
      total: numOr(r.total, 0),
      notes: str(r.notes) || null,
    })
  }
  return { rows: out, summary: { total_in_file: rows.length, skipped: skipped, total_to_import: out.length } }
}

async function runMain(db: SupabaseClient, rows: MappedRow[]): Promise<any> {
  // Build lookup maps for customer + vehicle.
  const custMdToId = new Map<string, string>()
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('workshop_customers').select('id, md_id').not('md_id', 'is', null).range(from, from + 999)
    if (!data || data.length === 0) break
    for (const r of data) custMdToId.set((r as any).md_id, (r as any).id)
    if (data.length < 1000) break
  }
  const vehByRego = new Map<string, string>()
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('workshop_vehicles').select('id, rego').not('rego', 'is', null).range(from, from + 999)
    if (!data || data.length === 0) break
    for (const r of data) { const nr = normRego((r as any).rego); if (nr && !vehByRego.has(nr)) vehByRego.set(nr, (r as any).id) }
    if (data.length < 1000) break
  }
  // Existing quotes by md_id (for re-runs).
  const existingMd = new Set<string>()
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('workshop_quotes').select('md_id').not('md_id', 'is', null).range(from, from + 999)
    if (!data || data.length === 0) break
    for (const r of data) existingMd.add((r as any).md_id)
    if (data.length < 1000) break
  }

  const inserts: any[] = []
  const summary = { inserted: 0, already_linked: 0, no_customer: 0, no_vehicle: 0, errors: 0 }
  for (const r of rows) {
    if (existingMd.has(r.md_id)) { summary.already_linked++; continue }
    const customer_id = r.customer_md_id ? custMdToId.get(r.customer_md_id) : null
    if (r.customer_md_id && !customer_id) summary.no_customer++
    const vehicle_id = r.vehicle_rego ? vehByRego.get(normRego(r.vehicle_rego)) : null
    if (r.vehicle_rego && !vehicle_id) summary.no_vehicle++
    inserts.push({
      md_id: r.md_id, customer_id: customer_id || null, vehicle_id: vehicle_id || null,
      status: r.status, subtotal: r.subtotal, gst: r.gst, total: r.total, notes: r.notes,
    })
  }
  for (let i = 0; i < inserts.length; i += 500) {
    const batch = inserts.slice(i, i + 500)
    const { error } = await db.from('workshop_quotes').insert(batch)
    if (error) { summary.errors += batch.length; continue }
    summary.inserted += batch.length
  }
  return summary
}

export const QUOTES_CONFIG: ImportTypeConfig = {
  id: 'quotes',
  label: 'Quotes',
  roles: [{ id: 'main', label: 'Quote headers', sheets: ['Quotes', 'Quote'], fields: FIELDS, required: true }],
  normalize: (data: MultiRoleRows) => { const r = normalizeMain(data.main || []); return { rows: { main: r.rows }, summary: r.summary } },
  run: async (db: SupabaseClient, data: MultiRoleRows) => runMain(db, data.main || []),
  blurb: 'Header-only quote import (no line items yet). Links to customers via external customer ID and vehicles via rego. Skips already-imported quote IDs.',
}
