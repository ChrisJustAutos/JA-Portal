// lib/stocktake-parser.ts
//
// Parse a stocktake XLSX into rows. Auto-detects which columns hold the
// SKU/product code and the counted quantity by looking at the header row.
// Tolerant of:
//   • Extra columns (ignored)
//   • Header row in row 1 OR row 2 (some MYOB/MD exports put a title above)
//   • Blank SKU rows (skipped)
//   • Whitespace-padded values
//   • Mixed-case header text
//   • Numeric SKUs (treated as strings)
//   • Different column orderings

export interface ParsedRow {
  row_number: number  // 1-based, source row in the spreadsheet
  sku: string
  qty: number
  raw_name?: string   // optional product name if the file has one (purely informational)
}

export interface ParseResult {
  rows: ParsedRow[]
  warnings: string[]
  total_rows: number       // rows processed
  skipped_blank: number    // rows skipped because SKU was blank
  skipped_invalid: number  // rows skipped because qty wasn't a number
  duplicate_skus: string[] // SKUs that appear more than once
  detected_columns: {
    sku_col: string   // letter (e.g. "A")
    qty_col: string
    name_col?: string
    header_row: number
  } | null
}

const SKU_HEADER_PATTERNS = [
  /^sku$/i,
  /^stock\s*(number|no|code|#)?$/i,
  /^product\s*(code|number|no|#)?$/i,
  /^item\s*(code|number|no|#)?$/i,
  /^part\s*(no|number|#)?$/i,
  /^code$/i,
  /^number$/i,
]

const QTY_HEADER_PATTERNS = [
  /^count(ed)?(\s*qty|\s*quantity)?$/i,
  /^qty$/i,
  /^quantity$/i,
  /^counted$/i,
  /^(physical|actual)\s*(qty|quantity|count)?$/i,
  /^stocktake\s*(qty|quantity|count)?$/i,
  /^on\s*hand$/i,
]

const NAME_HEADER_PATTERNS = [
  /^name$/i,
  /^product\s*name$/i,
  /^description$/i,
  /^stock\s*name$/i,
  /^item\s*name$/i,
]

function colLetter(idx: number): string {
  // 0-indexed → "A", "B", … "Z", "AA", "AB", …
  let n = idx
  let s = ''
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  }
  return s
}

function matchHeader(value: string, patterns: RegExp[]): boolean {
  if (!value) return false
  const trimmed = String(value).trim()
  return patterns.some(p => p.test(trimmed))
}

/**
 * Parse a workbook (already loaded by `xlsx` library) into rows.
 * Caller is responsible for reading the file and passing the worksheet.
 *
 * `worksheet` is the result of XLSX.utils.sheet_to_json with header:1 option,
 * giving us a 2D array. We do this manually because we need to find the
 * header row dynamically.
 */
export function parseStocktakeRows(rawRows: any[][]): ParseResult {
  const warnings: string[] = []

  if (!rawRows || rawRows.length === 0) {
    return {
      rows: [], warnings: ['Spreadsheet is empty.'],
      total_rows: 0, skipped_blank: 0, skipped_invalid: 0, duplicate_skus: [],
      detected_columns: null,
    }
  }

  // Find the header row — try rows 0 and 1
  let headerRowIdx = -1
  let skuColIdx = -1
  let qtyColIdx = -1
  let nameColIdx = -1

  for (let r = 0; r < Math.min(rawRows.length, 5); r++) {
    const row = rawRows[r] || []
    let foundSku = -1
    let foundQty = -1
    let foundName = -1
    for (let c = 0; c < row.length; c++) {
      const cell = row[c]
      if (cell == null) continue
      const str = String(cell)
      if (foundSku === -1 && matchHeader(str, SKU_HEADER_PATTERNS)) foundSku = c
      if (foundQty === -1 && matchHeader(str, QTY_HEADER_PATTERNS)) foundQty = c
      if (foundName === -1 && matchHeader(str, NAME_HEADER_PATTERNS)) foundName = c
    }
    if (foundSku !== -1 && foundQty !== -1) {
      headerRowIdx = r
      skuColIdx = foundSku
      qtyColIdx = foundQty
      nameColIdx = foundName
      break
    }
  }

  if (headerRowIdx === -1) {
    return {
      rows: [],
      warnings: [
        'Could not auto-detect SKU and Quantity columns from the header row.',
        'Expected headers like: "SKU"/"Stock Number"/"Product Code" + "Qty"/"Counted"/"Quantity".',
        'First row content: ' + JSON.stringify(rawRows[0]).slice(0, 200),
      ],
      total_rows: 0, skipped_blank: 0, skipped_invalid: 0, duplicate_skus: [],
      detected_columns: null,
    }
  }

  const detected_columns = {
    sku_col: colLetter(skuColIdx),
    qty_col: colLetter(qtyColIdx),
    name_col: nameColIdx >= 0 ? colLetter(nameColIdx) : undefined,
    header_row: headerRowIdx + 1,  // 1-based for user-facing display
  }

  const rows: ParsedRow[] = []
  const seenSkus = new Map<string, number>()  // sku → first row number
  const duplicates = new Set<string>()
  let skipped_blank = 0
  let skipped_invalid = 0

  for (let r = headerRowIdx + 1; r < rawRows.length; r++) {
    const row = rawRows[r] || []
    const sourceRowNum = r + 1  // 1-based

    const skuRaw = row[skuColIdx]
    const qtyRaw = row[qtyColIdx]
    const nameRaw = nameColIdx >= 0 ? row[nameColIdx] : undefined

    const sku = skuRaw == null ? '' : String(skuRaw).trim()
    if (!sku) {
      skipped_blank++
      continue
    }

    // Parse qty — accept numbers, numeric strings, and treat blank/non-numeric
    // as a skip with warning
    let qty: number
    if (qtyRaw == null || qtyRaw === '') {
      skipped_invalid++
      warnings.push(`Row ${sourceRowNum}: SKU "${sku}" has no quantity — skipped`)
      continue
    }
    if (typeof qtyRaw === 'number') {
      qty = qtyRaw
    } else {
      const cleaned = String(qtyRaw).trim().replace(/[,\s]/g, '')
      const parsed = Number(cleaned)
      if (!isFinite(parsed)) {
        skipped_invalid++
        warnings.push(`Row ${sourceRowNum}: SKU "${sku}" has non-numeric quantity "${qtyRaw}" — skipped`)
        continue
      }
      qty = parsed
    }

    // Negative quantities are usually a data error
    if (qty < 0) {
      warnings.push(`Row ${sourceRowNum}: SKU "${sku}" has negative quantity ${qty} — included anyway, but check`)
    }

    if (seenSkus.has(sku)) {
      duplicates.add(sku)
      warnings.push(`Row ${sourceRowNum}: SKU "${sku}" duplicates row ${seenSkus.get(sku)} — both kept`)
    } else {
      seenSkus.set(sku, sourceRowNum)
    }

    rows.push({
      row_number: sourceRowNum,
      sku,
      qty,
      raw_name: nameRaw == null ? undefined : String(nameRaw).trim() || undefined,
    })
  }

  if (rows.length === 0 && skipped_blank === 0 && skipped_invalid === 0) {
    warnings.push('No data rows found below the header.')
  }

  return {
    rows,
    warnings,
    total_rows: rows.length,
    skipped_blank,
    skipped_invalid,
    duplicate_skus: Array.from(duplicates),
    detected_columns,
  }
}
