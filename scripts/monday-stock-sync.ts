// scripts/monday-stock-sync.ts
//
// Twice-daily GH Actions worker that syncs Mechanics Desk inventory
// alerts → Monday "Product Availability Delays" board (id 2060835661).
//
// Flow (pivoted away from the Google Sheet stocktake list):
//   1. Login to Mechanics Desk via Playwright.
//   2. Paginate /stocks.json (~28 pages × 30 stocks ≈ 840 total).
//      Filter in JS to qualifying stocks:
//         stock_alert === true            (alert is enabled)
//         alert_quantity > 0              (threshold is set)
//         available_quantity < alert_quantity  (currently below threshold)
//         !deleted && !deactivated && !disable_tracking
//   3. Map count → board's Availability label:
//        0  → Not Available
//        1  → Very low
//        2-3 → Low
//        4-5 → Moderate
//        6+ → Good  (in practice rare here — those wouldn't be < alert)
//   4. Fetch existing Monday items by Part Number. For each qualifying
//      stock:
//        - Existing item    → update Availability if changed
//        - No existing item → create new in "Delays" group with Name,
//          Part Number, Vehicle (fuzzy from name), Availability,
//          ETA = TBA. No update/notification (Morgan asked us not to).
//
// Env vars (set as GH Actions secrets):
//   MONDAY_API_TOKEN
//   MECHANICDESK_WORKSHOP_ID / USERNAME / PASSWORD

import { loginToMechanicDesk, type MdClient } from '../lib/mechanicdesk-stocktake'

// ── Constants ──────────────────────────────────────────────────────────

const MD_BASE = 'https://www.mechanicdesk.com.au'

const BOARD_ID = 2060835661
const DELAYS_GROUP_ID = 'topics'
const RESOLVED_GROUP_ID = 'group_mktzbr3f' // "Update Complete"

const COL = {
  partNumber:    'text_mkv0n9h7',
  vehicle:       'status_1_mkm843wy',
  availability:  'status',
  eta:           'color_mkncj8ds',
}

// Vehicle label keywords (case-insensitive substring match against the
// product name). Multiple hits → 'OTHER' to stay safe.
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
  const hits: string[] = []
  for (const v of VEHICLE_KEYWORDS) {
    for (const kw of v.keywords) {
      if (n.includes(kw)) { hits.push(v.label); break }
    }
  }
  return hits.length === 1 ? hits[0] : 'OTHER'
}

function availabilityLabel(stock: number): string {
  const n = Math.max(0, Math.floor(stock))
  if (n === 0) return 'Not Available'
  if (n === 1) return 'Very low'
  if (n <= 3)  return 'Low'
  if (n <= 5)  return 'Moderate'
  return 'Good'
}

function log(msg: string) { console.log(`[${new Date().toISOString()}] ${msg}`) }

// ── MD inventory pagination ────────────────────────────────────────────

interface MdInventoryItem {
  id: number
  name: string
  stock_number: string
  stock_alert: boolean
  alert_quantity: number
  available_quantity: number
  quantity: number
  deleted: boolean
  deactivated: boolean
  disable_tracking: boolean
  tags?: any[]
}

async function fetchAllStocks(client: MdClient): Promise<MdInventoryItem[]> {
  const all: MdInventoryItem[] = []
  let page = 1
  while (page <= 200) {
    const url = `${MD_BASE}/stocks.json?page=${page}`
    const r = await fetch(url, {
      headers: {
        'Cookie': client.cookieHeader,
        'Accept': 'application/json',
        'User-Agent': 'ja-portal-stock-sync',
      },
    })
    if (!r.ok) throw new Error(`MD /stocks.json page ${page} → HTTP ${r.status}`)
    const j: any = await r.json()
    const stocks: MdInventoryItem[] = Array.isArray(j.stocks) ? j.stocks : []
    all.push(...stocks)
    const meta = j.meta || {}
    const totalPages = Number(meta.total_pages || 1)
    if (page === 1) log(`MD inventory: ${totalPages} pages × ~${stocks.length} per page`)
    if (page >= totalPages || stocks.length === 0) break
    page++
  }
  return all
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
  partNumber: string
  availabilityLabel: string | null
  groupId: string | null
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
            group { id }
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
      const groupId = it.group?.id || null
      items.push({ id: it.id, name: it.name, partNumber, availabilityLabel: availability, groupId })
    }
    cursor = page_?.cursor || null
    if (!cursor) break
  }
  return items
}

async function moveItemToGroup(itemId: string, groupId: string): Promise<void> {
  const q = `mutation ($itemId: ID!, $groupId: String!) {
    move_item_to_group(item_id: $itemId, group_id: $groupId) { id }
  }`
  await mondayQuery(q, { itemId, groupId })
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

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  log('=== Monday stock sync (MD inventory → alert-based) ===')

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
    await browser.close().catch(() => {})
  }

  // Pull MD inventory
  log('Pulling MD inventory (paginated)…')
  const allStocks = await fetchAllStocks(client)
  log(`MD total inventory rows: ${allStocks.length}`)

  // Filter to "below alert" stocks AND skip anything still in Good range
  // (6+). Even if a part is technically below its alert threshold, if there
  // are still 6+ on the shelf it doesn't belong on the Delays board.
  const qualifying = allStocks.filter(s => {
    if (s.deleted) return false
    if (s.deactivated) return false
    if (s.disable_tracking) return false
    if (!s.stock_alert) return false
    if (typeof s.alert_quantity !== 'number' || s.alert_quantity <= 0) return false
    if (typeof s.available_quantity !== 'number') return false
    if (s.available_quantity >= s.alert_quantity) return false
    if (s.available_quantity > 5) return false
    return true
  })
  log(`Below-alert + ≤5 on-hand qualifying stocks: ${qualifying.length}`)

  // Fetch existing Monday items
  log('Fetching existing Monday board items…')
  const existing = await fetchBoardItems()
  const byPartNumber = new Map<string, MondayItem>()
  for (const it of existing) {
    if (it.partNumber) byPartNumber.set(it.partNumber.toLowerCase(), it)
  }
  log(`Board has ${existing.length} items, ${byPartNumber.size} with Part Number set`)

  // Build a set of currently-qualifying part numbers so we can detect
  // which board items are now resolved (no longer below alert, or now Good).
  const qualifyingPartNumbers = new Set<string>()
  for (const s of qualifying) {
    const sn = String(s.stock_number || '').trim().toLowerCase()
    if (sn) qualifyingPartNumbers.add(sn)
  }

  // Process qualifying stocks
  let stats = { updated: 0, created: 0, noChange: 0, errors: 0, moved: 0 }
  let idx = 0
  for (const s of qualifying) {
    idx++
    const sn = String(s.stock_number || '').trim()
    if (!sn) continue
    const prefix = `[${idx}/${qualifying.length}] ${sn}`
    try {
      const availLabel = availabilityLabel(s.available_quantity)
      const existingItem = byPartNumber.get(sn.toLowerCase())
      if (existingItem) {
        if (existingItem.availabilityLabel === availLabel) {
          stats.noChange++
          // No log noise for unchanged — keep summary clean.
        } else {
          await updateAvailability(existingItem.id, availLabel)
          stats.updated++
          log(`${prefix} · updated ${existingItem.availabilityLabel || '(blank)'} → ${availLabel} (qty ${s.available_quantity}/alert ${s.alert_quantity})`)
        }
      } else {
        const vehicle = fuzzyVehicle(s.name)
        const itemId = await createItem({
          name: s.name || sn,
          partNumber: sn,
          vehicleLabel: vehicle,
          availabilityLabel: availLabel,
        })
        stats.created++
        log(`${prefix} · CREATED ${itemId} · ${s.name || sn} · ${vehicle} · ${availLabel} (qty ${s.available_quantity}/alert ${s.alert_quantity})`)
      }
    } catch (e: any) {
      stats.errors++
      log(`${prefix} · ERROR: ${(e?.message || String(e)).slice(0, 300)}`)
    }
  }

  // Move items on the Delays board that are no longer qualifying into
  // the "Update Complete" group. Only touch items still in the Delays
  // group — anything Morgan already moved elsewhere has been triaged.
  for (const it of existing) {
    if (it.groupId !== DELAYS_GROUP_ID) continue
    if (!it.partNumber) continue   // manual entry without a part number — leave alone
    const partKey = it.partNumber.toLowerCase()
    if (qualifyingPartNumbers.has(partKey)) continue
    try {
      await moveItemToGroup(it.id, RESOLVED_GROUP_ID)
      stats.moved++
      log(`moved → Update Complete · ${it.partNumber} · ${it.name} (was ${it.availabilityLabel || '(blank)'} — now resolved or Good)`)
    } catch (e: any) {
      stats.errors++
      log(`move ${it.partNumber} · ERROR: ${(e?.message || String(e)).slice(0, 300)}`)
    }
  }

  log(`=== Done. MD-total ${allStocks.length} · Below-alert ${qualifying.length} · Created ${stats.created} · Updated ${stats.updated} · No-change ${stats.noChange} · Moved-to-resolved ${stats.moved} · Errors ${stats.errors} ===`)
  if (stats.errors > 0) process.exit(1)
}

main().catch(e => {
  log(`FATAL: ${e?.message || e}`)
  console.error(e)
  process.exit(1)
})
