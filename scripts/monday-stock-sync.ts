// scripts/monday-stock-sync.ts
//
// Twice-daily GH Actions worker that syncs stock availability into the
// Monday "Product Availability Delays" board (id 2060835661).
//
// Flow:
//   1. Download Morgan's stocktake xlsx from Google Drive
//      (sheet id 1qpUFT-bI4U3bB0uqW2aNqD6ZIe3-Y4Qd, shared "anyone with link")
//   2. Parse the 3 rack tabs (DOWNSTAIRS / BULK RACKING / UPSTAIRS RACKING)
//      and pull stock_number + name from each row
//   3. Login to Mechanics Desk via Playwright; for each part, call
//      findStockBySku → available count
//   4. Map count → board's Availability status label:
//        0  → Not Available
//        1  → Very low
//        2-3 → Low
//        4-5 → Moderate
//        6+ → Good
//   5. Fetch all items currently on the Monday board, index by Part Number
//   6. For each sheet row:
//        - if Part Number matches an existing Monday item → update Availability
//          (leave Priority + ETA + Notes alone, per Morgan)
//        - else → create a new item in the "Delays" group with Name,
//          Part Number, Vehicle (fuzzy-matched from the product name),
//          Availability, ETA = TBA. Then post a create_update on it tagging
//          Morgan + Terry, AND send each an explicit create_notification.
//
// Env vars expected (set as GH Actions secrets):
//   MONDAY_API_TOKEN
//   MECHANICDESK_WORKSHOP_ID / USERNAME / PASSWORD
//   GOOGLE_SHEET_ID  (default: 1qpUFT-bI4U3bB0uqW2aNqD6ZIe3-Y4Qd)

import * as XLSX from 'xlsx'
import { loginToMechanicDesk, findStockBySku, type MdClient } from '../lib/mechanicdesk-stocktake'

// ── Constants ──────────────────────────────────────────────────────────

const BOARD_ID = 2060835661
const DELAYS_GROUP_ID = 'topics'
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1QYNf9YdxH0xMP9-J5I_L47BA6rYq14Fy'

const COL = {
  partNumber:    'text_mkv0n9h7',
  vehicle:       'status_1_mkm843wy',
  availability:  'status',
  eta:           'color_mkncj8ds',
}

// Monday user IDs
const NOTIFY_USER_IDS = {
  morgan: 54523486,
  terry:  79602714,
} as const

// Vehicle label keywords (case-insensitive substring match against the
// product name). First match wins; multiple hits → 'OTHER' to stay safe.
const VEHICLE_KEYWORDS: Array<{ label: string; keywords: string[] }> = [
  { label: 'FJA300',  keywords: ['fja300', 'fja 300', '300 series', 'lc300', 'land cruiser 300'] },
  { label: 'VDJ200',  keywords: ['vdj200', 'vdj 200', '200 series', 'lc200', 'land cruiser 200'] },
  { label: 'VDJ70*',  keywords: ['vdj70', 'vdj 70', '1vd-ftv 70'] },
  { label: 'GDJ70*',  keywords: ['gdj70', 'gdj 70', '1gd 70', '70 series'] },
  { label: 'GDJ250',  keywords: ['gdj250', 'gdj 250', 'prado 250', '250 prado'] },
  { label: 'GUN126R', keywords: ['gun126', 'gun 126', 'n80', 'hilux'] },
]

function fuzzyVehicle(name: string): string {
  const n = (name || '').toLowerCase()
  let hits: string[] = []
  for (const v of VEHICLE_KEYWORDS) {
    for (const kw of v.keywords) {
      if (n.includes(kw)) { hits.push(v.label); break }
    }
  }
  if (hits.length === 1) return hits[0]
  return 'OTHER'
}

function availabilityLabel(stock: number | null | undefined): string {
  if (stock == null) return 'Not Available'
  const n = Math.max(0, Math.floor(stock))
  if (n === 0) return 'Not Available'
  if (n === 1) return 'Very low'
  if (n <= 3)  return 'Low'
  if (n <= 5)  return 'Moderate'
  return 'Good'
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

// ── Sheet download + parse ─────────────────────────────────────────────

interface StockRow {
  sheet: string
  stockNumber: string
  name: string
  nonStock: boolean
}

async function downloadAndParseSheet(): Promise<StockRow[]> {
  const url = `https://docs.google.com/uc?export=download&id=${SHEET_ID}`
  log(`Downloading sheet from ${url}`)
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Sheet download failed: HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  log(`Sheet downloaded · ${buf.byteLength} bytes`)

  const wb = XLSX.read(buf, { type: 'buffer' })
  // Auto-detect rack sheets: process every tab EXCEPT 'Blank Sheet' (the
  // empty template). The shape inside each tab is identical: banner row,
  // optional blank row, then a 'Stock Number' header, then data.
  const sheetsToProcess = wb.SheetNames.filter(n => n.trim().toLowerCase() !== 'blank sheet')
  log(`Processing ${sheetsToProcess.length} tabs: ${sheetsToProcess.join(', ')}`)
  const rows: StockRow[] = []

  for (const sheetName of sheetsToProcess) {
    const ws = wb.Sheets[sheetName]
    if (!ws) { log(`Sheet "${sheetName}" missing — skipping`); continue }
    // Read as raw arrays so we can find the header row ourselves.
    const aoa = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: '' })
    // Find the row that starts with "Stock Number" (or close to it).
    const headerRowIdx = aoa.findIndex(r => String(r[0] || '').trim().toLowerCase() === 'stock number')
    if (headerRowIdx < 0) { log(`Sheet "${sheetName}" has no Stock Number header — skipping`); continue }
    // Resolve column indices dynamically from the header row — different
    // tabs may put Non-Stock at index 4 or 5.
    const headerRow = aoa[headerRowIdx].map(c => String(c || '').trim().toLowerCase())
    const idxStock    = headerRow.indexOf('stock number')
    const idxName     = headerRow.indexOf('name')
    const idxNonStock = headerRow.indexOf('non-stock')
    const dataRows = aoa.slice(headerRowIdx + 1)
    let added = 0, skippedBanner = 0, skippedNonStock = 0
    for (const r of dataRows) {
      const sn = String(r[idxStock] || '').trim()
      if (!sn) continue
      const nm = idxName >= 0 ? String(r[idxName] || '').trim() : ''
      // Filter out interstitial banner / section-header rows that appear
      // between sub-racks within the same xlsx tab (e.g. "RACK LOCATION M",
      // "EXTRAS", or another "Stock Number" header row). Real parts always
      // have a Name; banners don't.
      const looksLikeBanner =
        /^rack location\b/i.test(sn) ||
        sn.toLowerCase() === 'stock number' ||
        sn.toLowerCase() === 'extras' ||
        /^[A-Z][A-Z\s]+$/.test(sn) && !nm
      if (looksLikeBanner || !nm) { skippedBanner++; continue }
      const nonStockRaw = idxNonStock >= 0 ? r[idxNonStock] : false
      const nonStock = nonStockRaw === true || String(nonStockRaw || '').toLowerCase() === 'true'
      if (nonStock) { skippedNonStock++; continue }
      rows.push({ sheet: sheetName, stockNumber: sn, name: nm, nonStock })
      added++
    }
    log(`Sheet "${sheetName}" → ${added} rows (skipped ${skippedBanner} banner/blank, ${skippedNonStock} non-stock)`)
  }
  return rows
}

// ── Monday API helpers ─────────────────────────────────────────────────

const MONDAY_URL = 'https://api.monday.com/v2'

async function mondayQuery<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
  const token = process.env.MONDAY_API_TOKEN
  if (!token) throw new Error('MONDAY_API_TOKEN not set')
  const r = await fetch(MONDAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2024-01' },
    body: JSON.stringify({ query, variables: variables || {} }),
  })
  if (!r.ok) throw new Error(`Monday ${r.status}: ${(await r.text()).slice(0, 500)}`)
  const j = await r.json()
  if (j.errors) throw new Error(`Monday GraphQL: ${JSON.stringify(j.errors).slice(0, 500)}`)
  return j.data as T
}

interface MondayItem {
  id: string
  name: string
  partNumber: string  // pulled from column values
  availabilityLabel: string | null
}

async function fetchBoardItems(): Promise<MondayItem[]> {
  const items: MondayItem[] = []
  let cursor: string | null = null
  const colIds = [COL.partNumber, COL.availability]
  for (let page = 0; page < 50; page++) {
    const q = `query ($boardId: [ID!], $limit: Int!, $cursor: String, $cols: [String!]) {
      boards(ids: $boardId) {
        items_page(limit: $limit, cursor: $cursor) {
          cursor
          items {
            id
            name
            column_values(ids: $cols) { id text }
          }
        }
      }
    }`
    const data = await mondayQuery<any>(q, { boardId: [BOARD_ID], limit: 100, cursor, cols: colIds })
    const page_ = data.boards?.[0]?.items_page
    const its = page_?.items || []
    for (const it of its) {
      const partNumber = (it.column_values.find((c: any) => c.id === COL.partNumber)?.text || '').trim()
      const availability = it.column_values.find((c: any) => c.id === COL.availability)?.text || null
      items.push({ id: it.id, name: it.name, partNumber, availabilityLabel: availability })
    }
    cursor = page_?.cursor || null
    if (!cursor) break
  }
  return items
}

async function updateAvailability(itemId: string, label: string): Promise<void> {
  const values = JSON.stringify({ [COL.availability]: { label } })
  const q = `mutation ($itemId: ID!, $boardId: ID!, $values: JSON!) {
    change_multiple_column_values(item_id: $itemId, board_id: $boardId, column_values: $values) { id }
  }`
  await mondayQuery(q, { itemId, boardId: String(BOARD_ID), values })
}

async function createItem(args: {
  name: string
  partNumber: string
  vehicleLabel: string
  availabilityLabel: string
}): Promise<string> {
  const values = JSON.stringify({
    [COL.partNumber]:   args.partNumber,
    [COL.vehicle]:      { label: args.vehicleLabel },
    [COL.availability]: { label: args.availabilityLabel },
    [COL.eta]:          { label: 'TBA' },
  })
  const q = `mutation ($boardId: ID!, $groupId: String!, $name: String!, $values: JSON!) {
    create_item(board_id: $boardId, group_id: $groupId, item_name: $name, column_values: $values, create_labels_if_missing: false) { id }
  }`
  const r = await mondayQuery<any>(q, {
    boardId: String(BOARD_ID),
    groupId: DELAYS_GROUP_ID,
    name:    args.name,
    values,
  })
  return r.create_item.id
}

async function postUpdate(itemId: string, body: string): Promise<void> {
  const q = `mutation ($itemId: ID!, $body: String!) {
    create_update(item_id: $itemId, body: $body) { id }
  }`
  await mondayQuery(q, { itemId, body })
}

async function notifyUser(userId: number, itemId: string, text: string): Promise<void> {
  const q = `mutation ($userId: ID!, $targetId: ID!, $text: String!) {
    create_notification(user_id: $userId, target_id: $targetId, text: $text, target_type: Project) { id }
  }`
  try {
    await mondayQuery(q, { userId, targetId: itemId, text })
  } catch (e: any) {
    log(`notifyUser ${userId} failed: ${e?.message}`)
  }
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  log('=== Monday stock sync ===')

  const sheetRows = await downloadAndParseSheet()
  log(`Total sheet rows: ${sheetRows.length}`)

  // Dedupe by stock number — same part might appear in multiple rack tabs.
  const byStock = new Map<string, StockRow>()
  for (const r of sheetRows) {
    if (!byStock.has(r.stockNumber)) byStock.set(r.stockNumber, r)
  }
  const uniqueRows = Array.from(byStock.values())
  log(`After dedupe: ${uniqueRows.length} unique part numbers`)

  // Fetch existing Monday items first so we know what to update vs create.
  log('Fetching existing Monday board items…')
  const existing = await fetchBoardItems()
  const byPartNumber = new Map<string, MondayItem>()
  for (const it of existing) {
    if (it.partNumber) byPartNumber.set(it.partNumber.toLowerCase(), it)
  }
  log(`Board has ${existing.length} items, ${byPartNumber.size} with Part Number set`)

  // MD login
  const wsId = process.env.MECHANICDESK_WORKSHOP_ID
  const mdUser = process.env.MECHANICDESK_USERNAME
  const mdPass = process.env.MECHANICDESK_PASSWORD
  if (!wsId || !mdUser || !mdPass) throw new Error('MECHANICDESK_WORKSHOP_ID / USERNAME / PASSWORD env vars required')

  log('Launching headless Chromium for MD login…')
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  let client: MdClient
  try {
    const r = await loginToMechanicDesk(browser, wsId, mdUser, mdPass)
    client = r.client
    log(`MD login OK · ${client.cookieHeader.split(';').length} cookies`)
  } finally {
    // Keep the browser around in case Playwright needs it for follow-up
    // calls. The HTTP-based fetches will use cookies from client directly,
    // not the browser, so we can close it now.
    await browser.close().catch(() => {})
  }

  // Process rows
  let stats = { updated: 0, created: 0, skippedGood: 0, mdNotFound: 0, mdAmbiguous: 0, errors: 0 }
  let idx = 0
  let mdSampleDumped = 0
  for (const row of uniqueRows) {
    idx++
    const prefix = `[${idx}/${uniqueRows.length}] ${row.stockNumber}`
    try {
      const match = await findStockBySku(client, row.stockNumber)
      let stockCount: number | null = null
      if (match.kind === 'matched' && match.stock) {
        stockCount = typeof match.stock.available === 'number' ? match.stock.available : null
        // Dump the full MD stock object for the first 3 matches so we can
        // see what fields are available — looking for any "low moving" /
        // classification / velocity signal we can filter on.
        if (mdSampleDumped < 3) {
          log(`MD-SAMPLE ${row.stockNumber}: ${JSON.stringify(match.stock)}`)
          mdSampleDumped++
        }
      } else if (match.kind === 'ambiguous') {
        stats.mdAmbiguous++
        log(`${prefix} · MD ambiguous (${match.candidates?.length || 0} hits) — using first`)
        const first = match.candidates?.[0]
        stockCount = first && typeof first.available === 'number' ? first.available : null
      } else {
        stats.mdNotFound++
        log(`${prefix} · MD not found — treating as 0`)
        stockCount = 0
      }
      const availLabel = availabilityLabel(stockCount)

      const existingItem = byPartNumber.get(row.stockNumber.toLowerCase())
      if (existingItem) {
        // Always reflect the latest availability on items already on the board.
        if (existingItem.availabilityLabel === availLabel) {
          log(`${prefix} · already ${availLabel} (no change)`)
        } else {
          await updateAvailability(existingItem.id, availLabel)
          stats.updated++
          log(`${prefix} · updated ${existingItem.availabilityLabel || '(blank)'} → ${availLabel}`)
        }
      } else {
        // Only create new items for parts that actually need watching —
        // i.e. stock is below the "Good" threshold (≥6). Plenty-in-stock
        // parts don't need to clutter the Delays board.
        const needsTracking = (stockCount ?? 0) < 6
        if (!needsTracking) {
          stats.skippedGood++
          log(`${prefix} · skip create — stock ${stockCount} (Good), not adding to Delays`)
        } else {
          const vehicle = fuzzyVehicle(row.name)
          const itemId = await createItem({
            name: row.name || row.stockNumber,
            partNumber: row.stockNumber,
            vehicleLabel: vehicle,
            availabilityLabel: availLabel,
          })
          stats.created++
          log(`${prefix} · CREATED ${itemId} · ${row.name || row.stockNumber} · ${vehicle} · ${availLabel}`)
          // Per Morgan: no item updates / comments / notifications on
          // create. The Monday board itself is the signal — Morgan +
          // Terry will see new items appear when they look.
        }
      }
    } catch (e: any) {
      stats.errors++
      log(`${prefix} · ERROR: ${(e?.message || String(e)).slice(0, 300)}`)
    }
  }

  log(`=== Done. Updated ${stats.updated} · Created ${stats.created} · Skipped-good ${stats.skippedGood} · MD-not-found ${stats.mdNotFound} · MD-ambiguous ${stats.mdAmbiguous} · Errors ${stats.errors} ===`)
  if (stats.errors > 0) process.exit(1)
}

main().catch(e => {
  log(`FATAL: ${e?.message || e}`)
  console.error(e)
  process.exit(1)
})
