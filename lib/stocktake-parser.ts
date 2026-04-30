// lib/stocktake-parser.ts
//
// Parse a stocktake XLSX into rows. Auto-detects which columns hold the
// SKU/product code and the counted quantity by looking at the header row.
//
// Tolerant of:
//   • Multiple sheets in one workbook (e.g. tabs for Exhausts, Oils, Parts)
//   • Different column orderings per sheet
//   • Extra columns (ignored)
//   • Header row in row 1 OR somewhere in the first 5 rows
//   • Blank SKU rows (skipped)
//   • Whitespace-padded values
//   • Mixed-case header text
//   • Numeric SKUs (treated as strings)
//
// Sheets that don't have detectable SKU+Qty headers are skipped with a
// warning (likely summary, instructions, or legend tabs).

export interface ParsedRow {
  row_number: number   // 1-based, source row in the spreadsheet
  sku: string
  qty: number
  raw_name?: string    // optional product name if the file has one
  sheet_name?: string  // name of the sheet this row came from (for multi-tab workbooks)
}

export interface ParseResult {
  rows: ParsedRow[]
  warnings: string[]
  total_rows: number       // rows accepted
  skipped_blank: number    // rows skipped because SKU was blank
  skipped_invalid: number  // rows skipped because qty wasn't a number
  duplicate_skus: string[] // SKUs that appear more than once (cross-sheet)
  detected_columns: {
    sku_col: string
    qty_col: string
    name_col?: string
    header_row: number
    sheet_name?: string  // which sheet these columns were detected on
  } | null
  // Per-sheet breakdown for multi-sheet workbooks
  sheets?: SheetParseSummary[]
}

export interface SheetParseSummary {
  sheet_name: string
  rows_accepted: number
  skipped_blank: number
  skipped_invalid: number
  detected_columns: {
    sku_col: string
    qty_col: string
    name_col?: string
    header_row: number
  } | null
  skipped_reason?: string  // why the whole sheet was skipped, if applicable
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
 * Per-sheet parser. Takes a 2D array of cell values (the result of
 * XLSX.utils.sheet_to_json with header:1) and returns the rows it could
 * extract along with diagnostics.
 *
 * If headers can't be detected, returns rows=[] and a single warning —
 * the workbook-level wrapper handles that case by skipping the sheet.
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

  // Find the header row — scan up to first 5 rows
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
      warnings: ['Could not auto-detect SKU and Quantity columns from the header row.'],
      total_rows: 0, skipped_blank: 0, skipped_invalid: 0, duplicate_skus: [],
      detected_columns: null,
    }
  }

  const detected_columns = {
    sku_col: colLetter(skuColIdx),
    qty_col: colLetter(qtyColIdx),
    name_col: nameColIdx >= 0 ? colLetter(nameColIdx) : undefined,
    header_row: headerRowIdx + 1,
  }

  const rows: ParsedRow[] = []
  const seenSkus = new Map<string, number>()
  const duplicates = new Set<string>()
  let skipped_blank = 0
  let skipped_invalid = 0

  for (let r = headerRowIdx + 1; r < rawRows.length; r++) {
    const row = rawRows[r] || []
    const sourceRowNum = r + 1

    const skuRaw = row[skuColIdx]
    const qtyRaw = row[qtyColIdx]
    const nameRaw = nameColIdx >= 0 ? row[nameColIdx] : undefined

    const sku = skuRaw == null ? '' : String(skuRaw).trim()
    if (!sku) {
      skipped_blank++
      continue
    }

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

/**
 * Workbook-level parser. Loops over every sheet in the workbook, calls
 * parseStocktakeRows() on each, and merges the results. Each row is
 * tagged with its sheet name so duplicates across sheets are detectable
 * and warnings are traceable to a specific tab.
 *
 * Sheets where headers can't be detected (likely summary, instructions,
 * or legend tabs) are skipped with a warning rather than failing the
 * whole workbook.
 *
 * `sheetData` is an array of { name, rawRows } — caller is responsible
 * for loading the workbook with the `xlsx` library and producing this
 * input.
 */
export function parseStocktakeWorkbook(
  sheetData: Array<{ name: string; rawRows: any[][] }>,
): ParseResult {
  if (!sheetData || sheetData.length === 0) {
    return {
      rows: [], warnings: ['Workbook contains no sheets.'],
      total_rows: 0, skipped_blank: 0, skipped_invalid: 0, duplicate_skus: [],
      detected_columns: null,
      sheets: [],
    }
  }

  const allRows: ParsedRow[] = []
  const allWarnings: string[] = []
  const sheetSummaries: SheetParseSummary[] = []
  const seenSkus = new Map<string, { sheet: string; row: number }>()
  const duplicates = new Set<string>()
  let totalSkippedBlank = 0
  let totalSkippedInvalid = 0
  let firstDetectedColumns: ParseResult['detected_columns'] = null

  for (const { name, rawRows } of sheetData) {
    const result = parseStocktakeRows(rawRows)

    // If the sheet has no detectable headers, skip it gracefully — likely
    // a summary or instructions tab. Don't pollute warnings with row-level
    // noise from a sheet we couldn't parse.
    if (result.detected_columns == null) {
      sheetSummaries.push({
        sheet_name: name,
        rows_accepted: 0,
        skipped_blank: 0,
        skipped_invalid: 0,
        detected_columns: null,
        skipped_reason: 'No SKU/Quantity columns detected in header (likely a summary or instructions tab)',
      })
      allWarnings.push(`Sheet "${name}": skipped — no SKU/Quantity headers found`)
      continue
    }

    sheetSummaries.push({
      sheet_name: name,
      rows_accepted: result.rows.length,
      skipped_blank: result.skipped_blank,
      skipped_invalid: result.skipped_invalid,
      detected_columns: result.detected_columns,
    })

    // Capture the first sheet's detected_columns as the "headline" detection
    // for backward compat with the existing UI
    if (firstDetectedColumns == null) {
      firstDetectedColumns = { ...result.detected_columns, sheet_name: name }
    }

    // Tag each row with its sheet name and accumulate
    for (const row of result.rows) {
      const tagged: ParsedRow = { ...row, sheet_name: name }

      // Cross-sheet duplicate detection. Same SKU appearing in two tabs
      // is suspicious — could be the same physical item being counted in
      // both, which would double-up the qty. Warn but keep both.
      const seenAt = seenSkus.get(tagged.sku)
      if (seenAt) {
        duplicates.add(tagged.sku)
        if (seenAt.sheet !== name) {
          allWarnings.push(
            `Sheet "${name}" row ${tagged.row_number}: SKU "${tagged.sku}" also appears in sheet "${seenAt.sheet}" row ${seenAt.row} — both kept (counts will be summed when pushed)`
          )
        }
        // Per-sheet duplicate already warned by parseStocktakeRows
      } else {
        seenSkus.set(tagged.sku, { sheet: name, row: tagged.row_number })
      }

      allRows.push(tagged)
    }

    // Forward sheet-level warnings, prefixed with the sheet name
    for (const w of result.warnings) {
      // Skip the per-sheet duplicate warnings — we'll re-emit them at the
      // workbook level above for cross-sheet, and per-sheet ones are noise
      // when there are multiple sheets
      if (w.includes('duplicates row')) continue
      allWarnings.push(`Sheet "${name}": ${w}`)
    }

    totalSkippedBlank += result.skipped_blank
    totalSkippedInvalid += result.skipped_invalid
  }

  if (allRows.length === 0) {
    allWarnings.unshift('No usable rows found across any sheet in the workbook.')
  }

  return {
    rows: allRows,
    warnings: allWarnings,
    total_rows: allRows.length,
    skipped_blank: totalSkippedBlank,
    skipped_invalid: totalSkippedInvalid,
    duplicate_skus: Array.from(duplicates),
    detected_columns: firstDetectedColumns,
    sheets: sheetSummaries,
  }
}
