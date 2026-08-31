// lib/b2b-catalogue-port.ts
// Shared column spec for the B2B catalogue Excel export/import round-trip. One
// definition drives BOTH the export (headers + cell values + dropdowns) and the
// import (header → db field + parse/validate), so the two can never drift.
//
// Round-trip rules:
//   - ID / SKU / Name / Product Type are context only (read-only);
//     ID is the match key (SKU is the fallback).
//   - Model IS editable: a comma-separated list of model names. On import the
//     names are resolved to model ids and the fitment links are REPLACED. Blank
//     = leave unchanged (so an untouched export doesn't wipe fitment). Names must
//     already exist in Models (unknown names reject the file).
//   - A BLANK editable cell means "leave unchanged" (safe re-import), so an
//     untouched export changes nothing. (Clearing a value isn't done via blank.)
//   - Weight is shown/edited in kg but stored as grams.
//   - Dimensions are shown/edited in cm but stored as mm (matching the portal).
//   - Option fields (Packaging, Over-limit action, the TRUE/FALSE booleans) are
//     written as data-validation DROPDOWNS in the export (see export.ts).

export interface CatColumn {
  header: string
  field: string
  readOnly?: boolean
  kind?: 'text' | 'number' | 'int' | 'bool' | 'enum' | 'date' | 'weightKg' | 'lengthCm' | 'modelNames' | 'discountPct'
  enumValues?: string[]
  // Derived/embedded columns (model-fitment list, product-type name, discount %)
  // aren't real b2b_catalogue columns, so they're excluded from CATALOGUE_SELECT.
  notAColumn?: boolean
}

export const CATALOGUE_COLUMNS: CatColumn[] = [
  // ── Context (read-only) ──
  { header: 'ID',                          field: 'id',                              readOnly: true },
  { header: 'SKU',                         field: 'sku',                             readOnly: true },
  { header: 'Name',                        field: 'name',                            readOnly: true },
  { header: 'Model',                       field: 'models',                          kind: 'modelNames', notAColumn: true },
  { header: 'Product Type',                field: 'product_type_name',               readOnly: true, kind: 'text', notAColumn: true },
  // ── Editable ──
  { header: 'Description',                 field: 'description',                     kind: 'text' },
  { header: 'RRP ex GST',                  field: 'rrp_ex_gst',                      kind: 'number' },
  { header: 'Trade Price ex GST',          field: 'trade_price_ex_gst',              kind: 'number' },
  { header: 'Discount % (off RRP)',        field: 'discount_pct',                    kind: 'discountPct', notAColumn: true },
  { header: 'Cost Price ex GST',           field: 'cost_price_ex_gst',               kind: 'number' },
  { header: 'Visible',                     field: 'b2b_visible',                     kind: 'bool' },
  { header: 'Special Order',               field: 'is_special_order',                kind: 'bool' },
  { header: 'Drop Ship',                   field: 'is_drop_ship',                    kind: 'bool' },
  { header: 'Barcode',                     field: 'barcode',                         kind: 'text' },
  { header: 'Length (cm)',                 field: 'freight_length_mm',               kind: 'lengthCm' },
  { header: 'Width (cm)',                  field: 'freight_width_mm',                kind: 'lengthCm' },
  { header: 'Height (cm)',                 field: 'freight_height_mm',               kind: 'lengthCm' },
  { header: 'Weight (kg)',                 field: 'freight_weight_g',                kind: 'weightKg' },
  { header: 'Packaging',                   field: 'freight_packaging',               kind: 'enum', enumValues: ['box', 'pallet', 'other', 'unboxed'] },
  { header: 'Manual Handling',             field: 'manual_handling',                 kind: 'bool' },
  { header: 'Inbound Freight Cost ex GST', field: 'inbound_freight_cost_ex_gst',     kind: 'number' },
  { header: 'Below Stock Call For Order',  field: 'call_for_availability_below_qty', kind: 'int' },
  { header: 'Call For Order When Zero',    field: 'call_for_availability_when_zero', kind: 'bool' },
  { header: 'Min Order QTY',               field: 'min_order_qty',                   kind: 'int' },
  { header: 'Max Order QTY',               field: 'max_order_qty',                   kind: 'int' },
  { header: 'Over Limit QTY',              field: 'over_limit_qty',                  kind: 'int' },
  { header: 'Over Limit Action',           field: 'over_limit_action',               kind: 'enum', enumValues: ['quote', 'dropship'] },
  { header: 'Instructions URL',            field: 'instructions_url',                kind: 'text' },
  { header: 'Instructions URL 2',          field: 'instructions_url_2',              kind: 'text' },
  { header: 'Image URL',                   field: 'primary_image_url',               kind: 'text' },
]

// Columns to SELECT from b2b_catalogue for the export (real DB columns only;
// Model + Product Type are embedded separately by the export route).
// `discount_pct` is appended explicitly: the Discount % column is notAColumn
// (the importer derives a trade price from it rather than mapping it straight
// through), but the EXPORTER needs the stored value to round-trip an item that
// tracks RRP without silently pinning it (migration 215).
export const CATALOGUE_SELECT = CATALOGUE_COLUMNS.filter(c => !c.notAColumn).map(c => c.field).concat('discount_pct').join(', ')

// A db row → flat object keyed by header (for the exporter).
export function catalogueRowToExport(item: any): Record<string, any> {
  const out: Record<string, any> = {}
  for (const col of CATALOGUE_COLUMNS) {
    let v = item[col.field]
    if (col.kind === 'weightKg') v = (v == null ? '' : Math.round(Number(v)) / 1000)
    else if (col.kind === 'lengthCm') v = (v == null ? '' : Math.round(Number(v)) / 10)
    else if (col.kind === 'modelNames') v = (Array.isArray(v) ? v.map((m: any) => m?.name).filter(Boolean).join(', ') : '')
    else if (col.kind === 'date') v = (v ? new Date(v).toISOString() : '')
    else if (col.kind === 'bool') v = !!v
    else if (col.kind === 'discountPct') {
      // Export the STORED percentage when the item tracks RRP (migration 215) -
      // that is the intent, and round-tripping it keeps the item tracking. Only
      // fall back to deriving one from the prices for a PINNED item, at 4 dp so
      // an untouched round-trip reproduces its price to the cent.
      if (item.discount_pct != null) { v = Number(item.discount_pct); }
      else {
        const rrp = Number(item.rrp_ex_gst); const trade = Number(item.trade_price_ex_gst)
        v = (rrp > 0 && isFinite(trade)) ? Math.round((1 - trade / rrp) * 100 * 10000) / 10000 : ''
      }
    }
    else if (v == null) v = ''
    out[col.header] = v
  }
  return out
}

// A spreadsheet row (keyed by header) → { id?, sku?, patch } or { error }.
// Blank editable cells are skipped (no change). Returns an empty patch when the
// row only carried context columns.
export function catalogueRowToPatch(row: Record<string, any>): { id?: string; sku?: string; patch: Record<string, any>; modelNames?: string[] } | { error: string } {
  const id = String(row['ID'] ?? '').trim()
  const sku = String(row['SKU'] ?? '').trim()
  if (!id && !sku) return { error: 'row has neither ID nor SKU to match on' }
  const patch: Record<string, any> = {}
  let discountPct: number | null = null
  let modelNames: string[] | undefined
  for (const col of CATALOGUE_COLUMNS) {
    if (col.readOnly || !(col.header in row)) continue
    const cell = row[col.header]
    if (cell === '' || cell === null || cell === undefined) continue   // blank = leave unchanged
    if (col.kind === 'modelNames') {
      // Comma-separated model names → list (resolved to ids + applied by the
      // importer, since fitment lives in a join table, not a catalogue column).
      const names = String(cell).split(',').map(s => s.trim()).filter(Boolean)
      const seen = new Set<string>(); modelNames = []
      for (const n of names) { const k = n.toLowerCase(); if (!seen.has(k)) { seen.add(k); modelNames.push(n) } }
      continue
    }
    if (col.kind === 'discountPct') {
      const n = Number(cell)
      if (!isFinite(n) || n < 0 || n > 100) return { error: `${col.header} must be a number between 0 and 100` }
      discountPct = n   // applied after the loop so it overrides the Trade Price cell
      continue
    }
    if (col.kind === 'bool') {
      const s = String(cell).trim().toLowerCase()
      if (cell === true || ['true', '1', 'yes', 'y'].includes(s)) patch[col.field] = true
      else if (cell === false || ['false', '0', 'no', 'n'].includes(s)) patch[col.field] = false
      else return { error: `${col.header} must be TRUE or FALSE` }
    } else if (col.kind === 'enum') {
      const s = String(cell).trim().toLowerCase()
      if (!col.enumValues!.includes(s)) return { error: `${col.header} must be one of ${col.enumValues!.join(' / ')}` }
      patch[col.field] = s
    } else if (col.kind === 'date') {
      const d = cell instanceof Date ? cell : new Date(String(cell))
      if (isNaN(d.getTime())) return { error: `${col.header} must be a date (e.g. 2026-07-01) or blank` }
      patch[col.field] = d.toISOString()
    } else if (col.kind === 'int' || col.kind === 'weightKg' || col.kind === 'lengthCm' || col.kind === 'number') {
      const n = Number(cell)
      if (!isFinite(n) || n < 0) return { error: `${col.header} must be a non-negative number` }
      patch[col.field] = col.kind === 'weightKg' ? Math.round(n * 1000)
        : col.kind === 'lengthCm' ? Math.round(n * 10)
        : col.kind === 'int' ? Math.round(n) : n
    } else {
      patch[col.field] = String(cell)
    }
  }
  // Discount % wins: when set, it drives the trade price off RRP (the row's RRP
  // cell), overriding any Trade Price value in the same row.
  if (discountPct != null) {
    const rrp = patch.rrp_ex_gst != null ? Number(patch.rrp_ex_gst) : null
    if (rrp == null || !(rrp > 0)) return { error: 'Discount % needs an RRP ex GST value in the same row' }
    patch.trade_price_ex_gst = Math.round(rrp * (1 - discountPct / 100) * 100) / 100
    // Store the intent as well as the outcome, so the item keeps tracking RRP
    // after the import (migration 215) instead of freezing at today's price.
    patch.discount_pct = discountPct
  } else if (patch.trade_price_ex_gst != null) {
    // A trade price typed into the sheet with no percentage PINS the item -
    // same rule as the admin screens, or the next sync would overwrite it.
    patch.discount_pct = null
  }
  return { id: id || undefined, sku: sku || undefined, patch, modelNames }
}
