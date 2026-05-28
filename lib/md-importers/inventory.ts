// lib/md-importers/inventory.ts
//
// Inventory import. Match strategy: md_id (exact) → sku (case-insensitive).
// Quantities/prices update on match; identifiers (sku/part_name) preserved if
// the existing row already has them.

import { SupabaseClient } from '@supabase/supabase-js'
import { ImportField, ImportTypeConfig, MappedRow, MultiRoleRows } from './types'

const str = (v: any) => (v == null ? '' : String(v).trim())
const num = (v: any) => { const n = Number(v); return isFinite(n) ? n : null }
const numOr = (v: any, d: number) => { const n = Number(v); return isFinite(n) ? n : d }
const normSku = (v: any) => String(v || '').trim().toUpperCase()

const FIELDS: ImportField[] = [
  { id: 'md_id',         label: 'External Stock ID',   aliases: ['Stock ID', 'StockID', 'External ID', 'Source ID'], required: true, hint: 'Unique row ID from your source system' },
  { id: 'sku',           label: 'SKU',           aliases: ['Stock Number', 'SKU', 'Part Number', 'Code'] },
  { id: 'part_name',     label: 'Part name',     aliases: ['Name', 'Part Name', 'Description', 'Item'], required: true },
  { id: 'category',      label: 'Category',      aliases: ['Category', 'Group'] },
  { id: 'brand',         label: 'Brand',         aliases: ['Brand', 'Manufacturer'] },
  { id: 'barcode',       label: 'Barcode',       aliases: ['Barcode'] },
  { id: 'buy_price',     label: 'Buy price',     aliases: ['Buy Price', 'Cost Price', 'Cost', 'Average Buy Price'] },
  { id: 'sell_price',    label: 'Sell price',    aliases: ['Sell Price', 'Price', 'Retail Price', 'Sale Price'] },
  { id: 'quantity',      label: 'On hand',       aliases: ['Quantity', 'On Hand', 'Total Quantity', 'Qty'] },
  { id: 'location',      label: 'Location',      aliases: ['Location'] },
  { id: 'bin',           label: 'Bin',           aliases: ['Bin', 'Bin Location', 'Shelf'] },
  { id: 'supplier',      label: 'Supplier',      aliases: ['Supplier', 'Preferred Supplier'] },
  { id: 'uom',           label: 'Unit of measure', aliases: ['UOM', 'Unit', 'Unit of Measure'] },
]

function normalizeMain(rows: MappedRow[]) {
  let skipped = 0
  const out: MappedRow[] = []
  for (const r of rows) {
    const partName = str(r.part_name)
    const mdId = str(r.md_id)
    if (!partName || !mdId) { skipped++; continue }
    out.push({
      md_id: mdId,
      sku: str(r.sku) || null,
      part_name: partName,
      category: str(r.category) || null,
      brand: str(r.brand) || null,
      barcode: str(r.barcode) || null,
      buy_price: numOr(r.buy_price, 0),
      sell_price: numOr(r.sell_price, 0),
      quantity: numOr(r.quantity, 0),
      available: numOr(r.quantity, 0),  // approx; MD doesn't export allocated/available separately on the Stocks sheet
      allocated: 0, on_order: 0, alert_qty: 0, reorder_qty: 0, markup_pct: 0,
      is_non_stock: false, deactivated: false,
      location: str(r.location) || null,
      bin: str(r.bin) || null,
      supplier: str(r.supplier) || null,
      uom: str(r.uom) || null,
    })
  }
  return { rows: out, summary: { total_in_file: rows.length, skipped: skipped, total_to_import: out.length } }
}

async function runMain(db: SupabaseClient, rows: MappedRow[]): Promise<any> {
  const existing: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('workshop_inventory').select('id, sku, md_id').range(from, from + 999)
    if (!data || data.length === 0) break
    for (const r of data) existing.push(r)
    if (data.length < 1000) break
  }
  const byMdId = new Map<string, string>()
  const bySku = new Map<string, string>()
  for (const v of existing) {
    if (v.md_id) byMdId.set(v.md_id, v.id)
    const ns = normSku(v.sku)
    if (ns && !bySku.has(ns)) bySku.set(ns, v.id)
  }

  const updates: any[] = []
  const inserts: any[] = []
  const summary = { matched_md_id: 0, matched_sku: 0, inserted: 0, updated: 0, errors: 0 }

  for (const r of rows) {
    const matchId = byMdId.get(r.md_id) || (normSku(r.sku) && bySku.get(normSku(r.sku))) || null
    if (matchId) {
      if (byMdId.get(r.md_id)) summary.matched_md_id++; else summary.matched_sku++
      updates.push({ id: matchId, ...r })
    } else {
      inserts.push(r)
    }
  }

  for (let i = 0; i < updates.length; i += 500) {
    const batch = updates.slice(i, i + 500)
    const { error } = await db.from('workshop_inventory').upsert(batch, { onConflict: 'id' })
    if (error) { summary.errors += batch.length; continue }
    summary.updated += batch.length
  }
  for (let i = 0; i < inserts.length; i += 500) {
    const batch = inserts.slice(i, i + 500)
    const { error } = await db.from('workshop_inventory').insert(batch)
    if (error) { summary.errors += batch.length; continue }
    summary.inserted += batch.length
  }
  return summary
}

export const INVENTORY_CONFIG: ImportTypeConfig = {
  id: 'inventory',
  label: 'Inventory',
  roles: [{ id: 'main', label: 'Inventory', sheets: ['Stocks', 'Stock', 'Inventory', 'Items'], fields: FIELDS, required: true }],
  normalize: (data: MultiRoleRows) => { const r = normalizeMain(data.main || []); return { rows: { main: r.rows }, summary: r.summary } },
  run: async (db: SupabaseClient, data: MultiRoleRows) => runMain(db, data.main || []),
  blurb: 'Inventory rows match existing on External Stock ID, then SKU. Buy/sell prices + on-hand qty update on match. Defaults allocated/on-order to 0.',
}
