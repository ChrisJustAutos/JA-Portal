// lib/b2b-catalogue-port.ts
// Shared column spec for the B2B catalogue Excel export/import round-trip. One
// definition drives BOTH the export (headers + cell values) and the import
// (header → db field + parse/validate), so the two can never drift.
//
// Round-trip rules:
//   - ID / SKU / Name are context only (read-only) — ID is the match key.
//   - A BLANK editable cell means "leave unchanged" (safe re-import), so an
//     untouched export changes nothing. (Clearing a value isn't done via blank.)
//   - Weight is shown/edited in kg but stored as grams.

export interface CatColumn {
  header: string
  field: string
  readOnly?: boolean
  kind?: 'text' | 'number' | 'int' | 'bool' | 'enum' | 'weightKg'
  enumValues?: string[]
}

export const CATALOGUE_COLUMNS: CatColumn[] = [
  { header: 'ID',                       field: 'id',                        readOnly: true },
  { header: 'SKU',                      field: 'sku',                       readOnly: true },
  { header: 'Name',                     field: 'name',                      readOnly: true },
  { header: 'Trade Price ex GST',       field: 'trade_price_ex_gst',        kind: 'number' },
  { header: 'Visible',                  field: 'b2b_visible',               kind: 'bool' },
  { header: 'Length (mm)',              field: 'freight_length_mm',         kind: 'int' },
  { header: 'Width (mm)',               field: 'freight_width_mm',          kind: 'int' },
  { header: 'Height (mm)',              field: 'freight_height_mm',         kind: 'int' },
  { header: 'Weight (kg)',              field: 'freight_weight_g',          kind: 'weightKg' },
  { header: 'Packaging',                field: 'freight_packaging',         kind: 'enum', enumValues: ['box', 'pallet', 'other'] },
  { header: 'Drop Ship',                field: 'is_drop_ship',              kind: 'bool' },
  { header: 'Manual Handling',          field: 'manual_handling',           kind: 'bool' },
  { header: 'Inbound Freight Cost ex GST', field: 'inbound_freight_cost_ex_gst', kind: 'number' },
]

// Columns to SELECT from b2b_catalogue for the export.
export const CATALOGUE_SELECT = CATALOGUE_COLUMNS.map(c => c.field).join(', ')

// A db row → flat object keyed by header (for SheetJS json_to_sheet).
export function catalogueRowToExport(item: any): Record<string, any> {
  const out: Record<string, any> = {}
  for (const col of CATALOGUE_COLUMNS) {
    let v = item[col.field]
    if (col.kind === 'weightKg') v = (v == null ? '' : Math.round(Number(v)) / 1000)
    else if (col.kind === 'bool') v = !!v
    else if (v == null) v = ''
    out[col.header] = v
  }
  return out
}

// A spreadsheet row (keyed by header) → { id?, sku?, patch } or { error }.
// Blank editable cells are skipped (no change). Returns an empty patch when the
// row only carried context columns.
export function catalogueRowToPatch(row: Record<string, any>): { id?: string; sku?: string; patch: Record<string, any> } | { error: string } {
  const id = String(row['ID'] ?? '').trim()
  const sku = String(row['SKU'] ?? '').trim()
  if (!id && !sku) return { error: 'row has neither ID nor SKU to match on' }
  const patch: Record<string, any> = {}
  for (const col of CATALOGUE_COLUMNS) {
    if (col.readOnly || !(col.header in row)) continue
    const cell = row[col.header]
    if (cell === '' || cell === null || cell === undefined) continue   // blank = leave unchanged
    if (col.kind === 'bool') {
      const s = String(cell).trim().toLowerCase()
      if (cell === true || ['true', '1', 'yes', 'y'].includes(s)) patch[col.field] = true
      else if (cell === false || ['false', '0', 'no', 'n'].includes(s)) patch[col.field] = false
      else return { error: `${col.header} must be TRUE or FALSE` }
    } else if (col.kind === 'enum') {
      const s = String(cell).trim().toLowerCase()
      if (!col.enumValues!.includes(s)) return { error: `${col.header} must be one of ${col.enumValues!.join(' / ')}` }
      patch[col.field] = s
    } else if (col.kind === 'int' || col.kind === 'weightKg' || col.kind === 'number') {
      const n = Number(cell)
      if (!isFinite(n) || n < 0) return { error: `${col.header} must be a non-negative number` }
      patch[col.field] = col.kind === 'weightKg' ? Math.round(n * 1000) : (col.kind === 'int' ? Math.round(n) : n)
    } else {
      patch[col.field] = String(cell)
    }
  }
  return { id: id || undefined, sku: sku || undefined, patch }
}
