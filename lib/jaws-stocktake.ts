// lib/jaws-stocktake.ts
//
// JAWS stocktake engine — match an uploaded count sheet against MYOB (JAWS
// company file) inventory, and compute coverage (in-stock MYOB items that
// weren't counted).
//
// MYOB is queryable directly over the portal's AccountRight OAuth connection,
// so unlike the MechanicDesk stocktake there's no scraping worker — this runs
// in-process. We page the entire /Inventory/Item collection (same approach as
// lib/b2b-reorder sync), build a Number→item map, and resolve each SKU exactly.
// MYOB item Number is unique, so a SKU matches exactly 0 or 1 item (no
// "ambiguous" case like MD's name search).

import { getConnection, myobFetch } from './myob'
import type { ParsedRow } from './stocktake-parser'

const num = (v: any) => Number(v) || 0
const round2 = (n: number) => Math.round(n * 100) / 100

// The match-results list mirrors the uploaded sheet 1:1. Cap the stored
// coverage list so a partial count of a huge catalogue can't bloat the row;
// the CSV download still gets everything we kept here.
const COVERAGE_CAP = 5000

export interface JawsItem {
  number: string
  name: string
  onHand: number
  available: number
  committed: number
  buyPrice: number
  isActive: boolean
  isInventoried: boolean
}

export interface JawsMatchEntry {
  row_number: number
  sku: string
  qty: number
  sheet_name?: string
  status: 'matched' | 'not_found'
  myob_name?: string
  myob_number?: string
  myob_current_qty?: number   // QuantityOnHand at match time
  myob_available?: number
  myob_buy_price?: number
  sheet_bin?: string
  sheet_location?: string
}

export interface JawsCoverageItem {
  number: string
  name: string
  available: number      // on-hand qty
  buy_price: number
  value: number          // on-hand × buy price
}

export interface JawsCoverage {
  total: number              // in-stock items (on-hand > 0)
  counted: number            // in-stock items that were counted
  uncounted_count: number
  uncounted_value: number    // at buy price
  uncounted: JawsCoverageItem[]
  truncated?: boolean
  source: string
}

export interface JawsMatchResult {
  matchResults: JawsMatchEntry[]
  matchedCount: number
  unmatchedCount: number
  coverage: JawsCoverage
}

/**
 * Page the entire JAWS /Inventory/Item collection over the AccountRight OAuth
 * connection. Throws if the connection isn't configured or MYOB errors.
 */
export async function loadJawsInventory(performedBy?: string | null): Promise<JawsItem[]> {
  const conn = await getConnection('JAWS')
  if (!conn || !conn.company_file_id) {
    throw new Error('No active JAWS MYOB connection. Connect it in Settings → Connections first.')
  }
  const cf = `/accountright/${conn.company_file_id}`
  const items: JawsItem[] = []

  // $top 400 × up to 200 pages = 80k items — well past any realistic catalogue.
  for (let skip = 0, page = 0; page < 200; page++, skip += 400) {
    const r = await myobFetch(conn.id, `${cf}/Inventory/Item`, { query: { '$top': 400, '$skip': skip }, performedBy })
    if (r.status !== 200) {
      throw new Error(`MYOB Inventory/Item pull failed (HTTP ${r.status}): ${(r.raw || '').slice(0, 200)}`)
    }
    const rows: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
    for (const it of rows) {
      const number = String(it.Number || '').trim()
      if (!number) continue
      const onHand = num(it.QuantityOnHand)
      const committed = num(it.QuantityCommitted)
      items.push({
        number,
        name: String(it.Name || '').trim(),
        onHand,
        committed,
        available: it.QuantityAvailable != null ? num(it.QuantityAvailable) : onHand - committed,
        buyPrice: num(it.BuyingDetails?.StandardCost ?? it.AverageCost ?? 0),
        isActive: it.IsActive !== false,
        isInventoried: it.IsInventoried !== false,
      })
    }
    if (rows.length < 400) break
  }
  return items
}

/**
 * Match parsed count-sheet rows against the MYOB item list and compute
 * coverage. Pure (no I/O) so it's trivially testable.
 */
export function buildMatchAndCoverage(parsedRows: ParsedRow[], items: JawsItem[]): JawsMatchResult {
  // Number → item, case-insensitive. First occurrence wins (Number is unique
  // in MYOB anyway, but be defensive against dupes).
  const byNumber = new Map<string, JawsItem>()
  for (const it of items) {
    const key = it.number.trim().toUpperCase()
    if (key && !byNumber.has(key)) byNumber.set(key, it)
  }

  const matchResults: JawsMatchEntry[] = []
  const countedKeys = new Set<string>()
  let matchedCount = 0
  let unmatchedCount = 0

  for (const row of parsedRows || []) {
    const key = String(row.sku || '').trim().toUpperCase()
    const hit = key ? byNumber.get(key) : undefined
    const base: JawsMatchEntry = {
      row_number: row.row_number,
      sku: row.sku,
      qty: row.qty,
      sheet_name: row.sheet_name,
      sheet_bin: row.bin,
      sheet_location: row.location,
      status: 'not_found',
    }
    if (hit) {
      matchedCount++
      countedKeys.add(key)
      matchResults.push({
        ...base,
        status: 'matched',
        myob_name: hit.name,
        myob_number: hit.number,
        myob_current_qty: hit.onHand,
        myob_available: hit.available,
        myob_buy_price: hit.buyPrice,
      })
    } else {
      unmatchedCount++
      matchResults.push(base)
    }
  }

  // Coverage: every in-stock JAWS item (on-hand > 0) that wasn't counted.
  const inStock = items.filter(it => it.onHand > 0)
  const uncounted = inStock
    .filter(it => !countedKeys.has(it.number.trim().toUpperCase()))
    .map(it => ({
      number: it.number,
      name: it.name,
      available: it.onHand,
      buy_price: it.buyPrice,
      value: round2(it.onHand * it.buyPrice),
    }))
    .sort((a, b) => b.value - a.value)

  const uncountedValue = round2(uncounted.reduce((s, i) => s + i.value, 0))
  const coverage: JawsCoverage = {
    total: inStock.length,
    counted: inStock.length - uncounted.length,
    uncounted_count: uncounted.length,
    uncounted_value: uncountedValue,
    uncounted: uncounted.slice(0, COVERAGE_CAP),
    truncated: uncounted.length > COVERAGE_CAP,
    source: 'uploaded sheet',
  }

  return { matchResults, matchedCount, unmatchedCount, coverage }
}
