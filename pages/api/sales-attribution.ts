// pages/api/sales-attribution.ts
// Monday.com attribution data using the "Quote Selection" Connect column.
//
// This endpoint computes two complementary conversion views:
//
// 1. QUOTE-MONTH ATTRIBUTION
//    Of quotes sent in the target period, how many have been linked to an
//    order? Answers: "How is this month's pipeline closing?"
//
// 2. ORDER-MONTH ATTRIBUTION
//    Of orders placed in the target period, how many are linked back to a
//    quote (tracked) vs unlinked (walk-in/untracked)? Answers: "What's our
//    tracking quality, and what quote-age is driving this month's revenue?"
//
// The Connect column is `board_relation_mm2k8n34` ("Quote Selection") on
// the Orders board. It links Orders → quote boards OR distributor board.
// We read it FROM the Orders side (since that's where it exists currently).
// If/when a similar column is added to Distributor Booking, extend here.
//
// Graceful-empty-state: if no items have `linked_item_ids`, all percentages
// show 0 and the UI surfaces a "linkage completeness" indicator so you
// can see how much backfill remains.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'

export const config = { maxDuration: 60 }

const MONDAY_TOKEN = process.env.MONDAY_API_TOKEN || ''
const MONDAY_URL = 'https://api.monday.com/v2'

// ── Board and column constants (centralised for when they change) ────
const ORDERS_BOARD = '1838428097'
const DIST_BOOKING_BOARD = '1923220718'
const CONNECT_COL_ON_ORDERS = 'board_relation_mm2k8n34'  // "Quote Selection"
// TODO: once the Dist Booking board gets its Connect column, add its id here.
// e.g. const CONNECT_COL_ON_DIST_BOOKING = 'board_relation_xxxxx'
const CONNECT_COL_ON_DIST_BOOKING: string | null = null

const QUOTE_BOARDS = [
  { rep: 'Tyronne', full: 'Tyronne Wright', id: '5025942288' },
  { rep: 'James',   full: 'James Wilson',   id: '5025942292' },
  { rep: 'Dom',     full: 'Dom Simpson',    id: '5025942308' },
  { rep: 'Kaleb',   full: 'Kaleb Rowe',     id: '5025942316' },
  { rep: 'Graham',  full: 'Graham',         id: '5026840169' },
]

// Workshop order statuses considered "active" (see sales.ts for derivation)
const WORKSHOP_ORDER_STATUSES = [1, 2, 3, 5, 6]
// Distributor booking statuses considered "active" (see sales.ts)
const DISTRIBUTOR_ACTIVE_STATUSES = [0, 1, 3, 5]

const PAGE_SIZE = 500
const MAX_PAGES = 10

// ── Helpers ───────────────────────────────────────────────────────────

async function mondayQuery(query: string, variables?: any) {
  const res = await fetch(MONDAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_TOKEN, 'API-Version': '2024-10' },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`Monday API ${res.status}`)
  const data = await res.json()
  if (data.errors) throw new Error(data.errors[0]?.message || 'Monday API error')
  return data.data
}

// Paginate a top-level boards[].items_page query. The first page applies
// filters via query_params; subsequent pages use next_items_page with the
// cursor (Monday encodes the filter state into the cursor).
async function paginate(
  firstQuery: (limit: number) => string,
  selectionSetForNext: string,
): Promise<any[]> {
  const all: any[] = []
  const first = await mondayQuery(firstQuery(PAGE_SIZE))
  const firstPage = first?.boards?.[0]?.items_page
  if (firstPage?.items) all.push(...firstPage.items)
  let cursor: string | null = firstPage?.cursor || null

  let pages = 1
  while (cursor && pages < MAX_PAGES) {
    const next = await mondayQuery(`{
      next_items_page(limit: ${PAGE_SIZE}, cursor: "${cursor}") {
        cursor
        ${selectionSetForNext}
      }
    }`)
    const nextPage = next?.next_items_page
    if (!nextPage) break
    if (nextPage.items) all.push(...nextPage.items)
    cursor = nextPage.cursor || null
    pages++
  }
  if (cursor && pages >= MAX_PAGES) {
    console.warn(`sales-attribution: MAX_PAGES hit (${MAX_PAGES * PAGE_SIZE} items) — data may be truncated`)
  }
  return all
}

// Checks whether a YYYY-MM-DD date string falls within range (inclusive).
// Both args are YYYY-MM-DD; string comparison works correctly for this format.
function inRange(dateStr: string, start: string, end: string): boolean {
  if (!dateStr) return false
  return dateStr >= start && dateStr <= end
}

function monthKey(dateStr: string): string {
  return dateStr ? dateStr.substring(0, 7) : ''
}

// ── Core data shapes ──────────────────────────────────────────────────

interface RawQuote {
  id: string
  name: string
  repKey: string            // 'Tyronne' etc
  repFull: string
  date: string              // quote creation/sent date (date4)
  status: string
  quoteValue: number
  boardId: string
}

interface RawOrder {
  id: string
  name: string
  date: string              // order/booking date
  status: string
  value: number
  source: 'workshop' | 'distributor'
  linkedQuoteIds: string[]  // IDs from the Connect column (may be empty)
  linkedBoardIds: string[]  // board IDs of the linked items (to distinguish)
}

// ── Fetchers ──────────────────────────────────────────────────────────

// Fetch all quotes for one rep board.
async function fetchQuotesForBoard(board: typeof QUOTE_BOARDS[0]): Promise<RawQuote[]> {
  const items = await paginate(
    (limit) => `{ boards(ids: [${board.id}]) { items_page(limit: ${limit}) { cursor items { id name column_values(ids: ["date4", "status", "numeric_mkzcbhz2"]) { id text } } } } }`,
    `items { id name column_values(ids: ["date4", "status", "numeric_mkzcbhz2"]) { id text } }`,
  )
  return items.map((item: any) => {
    const cols = item.column_values || []
    const valStr = cols.find((c: any) => c.id === 'numeric_mkzcbhz2')?.text || '0'
    return {
      id: item.id,
      name: item.name || '',
      repKey: board.rep,
      repFull: board.full,
      date: cols.find((c: any) => c.id === 'date4')?.text || '',
      status: cols.find((c: any) => c.id === 'status')?.text || '',
      quoteValue: parseFloat(String(valStr).replace(/[^0-9.-]/g, '')) || 0,
      boardId: board.id,
    }
  })
}

// Fetch workshop orders in a date range, including the Connect column.
async function fetchWorkshopOrders(startDate: string, endDate: string): Promise<RawOrder[]> {
  const statusList = WORKSHOP_ORDER_STATUSES.join(',')
  // The Connect column needs a special fragment to pull linked_item_ids.
  // Note: we use ... on BoardRelationValue to expand the union type.
  const itemSelection = `items {
    id name
    column_values(ids: ["date", "numbers", "status", "${CONNECT_COL_ON_ORDERS}"]) {
      id text
      ... on BoardRelationValue { linked_item_ids linked_items { id board { id } } }
    }
  }`
  const items = await paginate(
    (limit) => `{
      boards(ids: [${ORDERS_BOARD}]) {
        items_page(
          limit: ${limit},
          query_params: {
            rules: [
              { column_id: "date", compare_value: ["${startDate}", "${endDate}"], operator: between },
              { column_id: "status", compare_value: [${statusList}], operator: any_of }
            ],
            operator: and
          }
        ) {
          cursor
          ${itemSelection}
        }
      }
    }`,
    itemSelection,
  )
  return items.map((item: any) => {
    const cols = item.column_values || []
    const dateStr = cols.find((c: any) => c.id === 'date')?.text || ''
    const statusStr = cols.find((c: any) => c.id === 'status')?.text || ''
    const valStr = cols.find((c: any) => c.id === 'numbers')?.text || '0'
    const connect = cols.find((c: any) => c.id === CONNECT_COL_ON_ORDERS)
    const linkedItemIds: string[] = connect?.linked_item_ids || []
    const linkedItems: any[] = connect?.linked_items || []
    return {
      id: item.id,
      name: item.name || '',
      date: dateStr,
      status: statusStr,
      value: parseFloat(String(valStr).replace(/[,$]/g, '')) || 0,
      source: 'workshop' as const,
      linkedQuoteIds: linkedItemIds.map(String),
      linkedBoardIds: linkedItems.map(li => String(li.board?.id || '')),
    }
  })
}

// Fetch distributor bookings in a date range, with Connect column if available.
async function fetchDistributorBookings(startDate: string, endDate: string): Promise<RawOrder[]> {
  const statusList = DISTRIBUTOR_ACTIVE_STATUSES.join(',')
  // Include the Connect column ONLY if it exists (feature flag via CONNECT_COL_ON_DIST_BOOKING)
  const connectFragment = CONNECT_COL_ON_DIST_BOOKING
    ? `"${CONNECT_COL_ON_DIST_BOOKING}",`
    : ''
  const itemSelection = `items {
    id name
    column_values(ids: [${connectFragment} "date_1", "numbers", "status"]) {
      id text
      ... on BoardRelationValue { linked_item_ids linked_items { id board { id } } }
    }
  }`
  const items = await paginate(
    (limit) => `{
      boards(ids: [${DIST_BOOKING_BOARD}]) {
        items_page(
          limit: ${limit},
          query_params: {
            rules: [
              { column_id: "status", compare_value: [${statusList}], operator: any_of }
            ]
          }
        ) {
          cursor
          ${itemSelection}
        }
      }
    }`,
    itemSelection,
  )
  return items
    .map((item: any) => {
      const cols = item.column_values || []
      const dateStr = cols.find((c: any) => c.id === 'date_1')?.text || ''
      const statusStr = cols.find((c: any) => c.id === 'status')?.text || ''
      const valStr = cols.find((c: any) => c.id === 'numbers')?.text || '0'
      const connect = CONNECT_COL_ON_DIST_BOOKING
        ? cols.find((c: any) => c.id === CONNECT_COL_ON_DIST_BOOKING)
        : null
      const linkedItemIds: string[] = connect?.linked_item_ids || []
      const linkedItems: any[] = connect?.linked_items || []
      return {
        id: item.id,
        name: item.name || '',
        date: dateStr,
        status: statusStr,
        value: parseFloat(String(valStr).replace(/[,$]/g, '')) || 0,
        source: 'distributor' as const,
        linkedQuoteIds: linkedItemIds.map(String),
        linkedBoardIds: linkedItems.map(li => String(li.board?.id || '')),
      }
    })
    // Apply date filter in-memory because query_params can only take one operator per column
    .filter((o: RawOrder) => inRange(o.date, startDate, endDate))
}

// ── Analysis ──────────────────────────────────────────────────────────

export interface SalesAttributionData {
  period: { start: string; end: string }
  generatedAt: string
  linkageCompleteness: {
    ordersInPeriod: number
    ordersWithLink: number
    pct: number
    distBookingConnectEnabled: boolean
  }
  repScorecard: Array<{
    rep: string
    fullName: string
    // Quote-month view: quotes sent IN PERIOD
    quotesSentInPeriod: number
    quotesSentValue: number
    quotesSentConverted: number     // of those, how many are now linked from an order
    quoteMonthConversionPct: number | null
    // Order-month view: orders booked IN PERIOD that link back to this rep's quotes
    ordersLinkedToRep: number
    ordersLinkedValue: number
    ordersLinkedFromPriorQuotes: number   // linked to quotes from earlier than period
    // Legacy (status-based) — kept for parity with existing reports
    activeLeads: number
    totalQuotesWonAllTime: number
    totalQuotesLostAllTime: number
  }>
  teamTotals: {
    quotesSentInPeriod: number
    quotesSentValue: number
    quotesSentConverted: number
    quoteMonthConversionPct: number | null
    ordersLinked: number
    ordersLinkedValue: number
    ordersUnlinked: number
    ordersUnlinkedValue: number
    orderMonthAttributionPct: number | null
  }
  quoteAging: {
    // For orders in period: how old was the linked quote at time of order?
    sameMonth: { count: number; value: number }
    last30d: { count: number; value: number }
    last60d: { count: number; value: number }
    older: { count: number; value: number }
    unlinked: { count: number; value: number }
  }
  priorMonths: Array<{
    monthKey: string              // "2026-03"
    label: string                  // "Mar 2026"
    quotesSent: number
    quotesConvertedToDate: number
    conversionPct: number | null
  }>
}

function analyze(
  quotesByRep: Map<string, RawQuote[]>,
  orders: RawOrder[],
  startDate: string,
  endDate: string,
): SalesAttributionData {
  // Build a quote id → quote lookup, across all reps
  const quoteById = new Map<string, RawQuote>()
  for (const quotes of Array.from(quotesByRep.values())) {
    for (const q of quotes) quoteById.set(q.id, q)
  }

  // ── Linkage completeness ─────────────────────────────────────────
  const ordersWithLink = orders.filter(o => o.linkedQuoteIds.length > 0).length
  const linkageCompleteness = {
    ordersInPeriod: orders.length,
    ordersWithLink,
    pct: orders.length > 0 ? Math.round((ordersWithLink / orders.length) * 100) : 0,
    distBookingConnectEnabled: CONNECT_COL_ON_DIST_BOOKING != null,
  }

  // ── Per-rep scorecard ────────────────────────────────────────────
  const repScorecard: SalesAttributionData['repScorecard'] = []
  let teamQuotesSent = 0, teamQuotesSentValue = 0, teamQuotesConverted = 0
  let teamOrdersLinked = 0, teamOrdersLinkedValue = 0
  const periodMonthKey = monthKey(startDate)  // assume period is within one month for the aging view

  for (const board of QUOTE_BOARDS) {
    const repQuotes = quotesByRep.get(board.rep) || []

    // Quote-month view — quotes sent in period
    const periodQuotes = repQuotes.filter(q => inRange(q.date, startDate, endDate))
    const periodQuoteIds = new Set(periodQuotes.map(q => q.id))
    const periodQuoteValue = periodQuotes.reduce((s, q) => s + q.quoteValue, 0)

    // Of those period-quotes, how many are linked from an order (any time)?
    const convertedPeriodQuotes = orders
      .flatMap(o => o.linkedQuoteIds)
      .filter(qid => periodQuoteIds.has(qid))
    const quotesSentConverted = new Set(convertedPeriodQuotes).size
    const quoteMonthConversionPct = periodQuotes.length > 0
      ? Math.round((quotesSentConverted / periodQuotes.length) * 100)
      : null

    // Order-month view — orders in period linked to THIS rep's quotes
    const ordersLinkedToRepQuotes = orders.filter(o =>
      o.linkedQuoteIds.some(qid => {
        const q = quoteById.get(qid)
        return q?.repKey === board.rep
      })
    )
    const ordersLinkedValue = ordersLinkedToRepQuotes.reduce((s, o) => s + o.value, 0)

    // Of those, how many linked to a quote from BEFORE the period (carryover)?
    const ordersFromPriorQuotes = ordersLinkedToRepQuotes.filter(o =>
      o.linkedQuoteIds.some(qid => {
        const q = quoteById.get(qid)
        return q?.repKey === board.rep && q.date < startDate
      })
    ).length

    // Legacy status counts (all-time, across whole board)
    const activeLeads = repQuotes.filter(q => {
      const s = q.status
      // "Active" = anything not Won/Lost/closed
      return !['Quote Won', 'Quote Lost', 'Not Interested', ''].includes(s)
    }).length
    const totalWon = repQuotes.filter(q => q.status === 'Quote Won').length
    const totalLost = repQuotes.filter(q => q.status === 'Quote Lost').length

    repScorecard.push({
      rep: board.rep,
      fullName: board.full,
      quotesSentInPeriod: periodQuotes.length,
      quotesSentValue: periodQuoteValue,
      quotesSentConverted,
      quoteMonthConversionPct,
      ordersLinkedToRep: ordersLinkedToRepQuotes.length,
      ordersLinkedValue,
      ordersLinkedFromPriorQuotes: ordersFromPriorQuotes,
      activeLeads,
      totalQuotesWonAllTime: totalWon,
      totalQuotesLostAllTime: totalLost,
    })

    teamQuotesSent += periodQuotes.length
    teamQuotesSentValue += periodQuoteValue
    teamQuotesConverted += quotesSentConverted
    teamOrdersLinked += ordersLinkedToRepQuotes.length
    teamOrdersLinkedValue += ordersLinkedValue
  }

  const ordersUnlinked = orders.filter(o => o.linkedQuoteIds.length === 0)
  const ordersUnlinkedValue = ordersUnlinked.reduce((s, o) => s + o.value, 0)

  const teamTotals = {
    quotesSentInPeriod: teamQuotesSent,
    quotesSentValue: teamQuotesSentValue,
    quotesSentConverted: teamQuotesConverted,
    quoteMonthConversionPct: teamQuotesSent > 0 ? Math.round((teamQuotesConverted / teamQuotesSent) * 100) : null,
    ordersLinked: teamOrdersLinked,
    ordersLinkedValue: teamOrdersLinkedValue,
    ordersUnlinked: ordersUnlinked.length,
    ordersUnlinkedValue,
    orderMonthAttributionPct: orders.length > 0 ? Math.round((teamOrdersLinked / orders.length) * 100) : null,
  }

  // ── Quote aging for orders in period ──────────────────────────────
  const quoteAging = {
    sameMonth: { count: 0, value: 0 },
    last30d: { count: 0, value: 0 },
    last60d: { count: 0, value: 0 },
    older: { count: 0, value: 0 },
    unlinked: { count: 0, value: 0 },
  }
  const periodStart = new Date(startDate + 'T00:00:00Z')
  for (const order of orders) {
    if (order.linkedQuoteIds.length === 0) {
      quoteAging.unlinked.count++
      quoteAging.unlinked.value += order.value
      continue
    }
    // Find the oldest linked quote (represents when work was first quoted)
    let oldestQuoteDate: string | null = null
    for (const qid of order.linkedQuoteIds) {
      const q = quoteById.get(qid)
      if (q?.date && (!oldestQuoteDate || q.date < oldestQuoteDate)) oldestQuoteDate = q.date
    }
    if (!oldestQuoteDate) {
      // Link exists but points to something we don't have (e.g. distributor booking linked from an order)
      quoteAging.unlinked.count++
      quoteAging.unlinked.value += order.value
      continue
    }
    if (monthKey(oldestQuoteDate) === periodMonthKey) {
      quoteAging.sameMonth.count++
      quoteAging.sameMonth.value += order.value
    } else {
      const quoteDate = new Date(oldestQuoteDate + 'T00:00:00Z')
      const daysAgo = Math.floor((periodStart.getTime() - quoteDate.getTime()) / (86400 * 1000))
      if (daysAgo <= 30) { quoteAging.last30d.count++; quoteAging.last30d.value += order.value }
      else if (daysAgo <= 60) { quoteAging.last60d.count++; quoteAging.last60d.value += order.value }
      else { quoteAging.older.count++; quoteAging.older.value += order.value }
    }
  }

  // ── Prior months trend ────────────────────────────────────────────
  // Show last 6 months of quote-month conversion.
  const priorMonths: SalesAttributionData['priorMonths'] = []
  const now = new Date(startDate + 'T00:00:00Z')
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const monthStart = `${mk}-01`
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
    const monthEnd = `${mk}-${String(lastDay).padStart(2, '0')}`
    const label = d.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })

    // Quotes sent in this month, across all reps
    let monthQuotes = 0, monthConverted = 0
    for (const quotes of Array.from(quotesByRep.values())) {
      const monthQuoteList = quotes.filter((q: RawQuote) => inRange(q.date, monthStart, monthEnd))
      monthQuotes += monthQuoteList.length
      const monthQuoteIds = new Set(monthQuoteList.map((q: RawQuote) => q.id))
      const linkedFromOrders = new Set(
        orders.flatMap(o => o.linkedQuoteIds).filter(qid => monthQuoteIds.has(qid))
      )
      monthConverted += linkedFromOrders.size
    }
    // Note: `monthConverted` only counts orders FROM the period we fetched (startDate..endDate).
    // Conversions to orders in other months aren't captured here. This is a limitation of the
    // current orders fetch scope. For a proper multi-month view we'd need to fetch orders
    // across all 6 months — punted for v1 to keep query volume down.
    priorMonths.push({
      monthKey: mk,
      label,
      quotesSent: monthQuotes,
      quotesConvertedToDate: monthConverted,
      conversionPct: monthQuotes > 0 ? Math.round((monthConverted / monthQuotes) * 100) : null,
    })
  }

  return {
    period: { start: startDate, end: endDate },
    generatedAt: new Date().toISOString(),
    linkageCompleteness,
    repScorecard,
    teamTotals,
    quoteAging,
    priorMonths,
  }
}

// ── Cache ─────────────────────────────────────────────────────────────
const CACHE_TTL = 5 * 60 * 1000
const cache = new Map<string, { data: SalesAttributionData; timestamp: number }>()

// ── Handler ───────────────────────────────────────────────────────────

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    if (!MONDAY_TOKEN) return res.status(500).json({ error: 'MONDAY_API_TOKEN not configured' })

    const startDate = (req.query.startDate as string) || '2026-04-01'
    const endDate = (req.query.endDate as string) || '2026-04-30'
    const refresh = req.query.refresh === 'true'

    const cacheKey = `attr:${startDate}:${endDate}`
    if (!refresh) {
      const cached = cache.get(cacheKey)
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return res.status(200).json(cached.data)
      }
    }

    try {
      // Fetch all reps' quotes (paginated) in parallel
      const quotesResult = await Promise.all(
        QUOTE_BOARDS.map(async (board) => {
          const quotes = await fetchQuotesForBoard(board).catch((e) => {
            console.error(`sales-attribution: fetchQuotesForBoard ${board.rep}:`, e.message)
            return [] as RawQuote[]
          })
          return [board.rep, quotes] as const
        })
      )
      const quotesByRep = new Map<string, RawQuote[]>(quotesResult)

      // Fetch orders + distributor bookings in parallel
      const [workshopOrders, distOrders] = await Promise.all([
        fetchWorkshopOrders(startDate, endDate).catch((e) => {
          console.error('sales-attribution: fetchWorkshopOrders:', e.message)
          return [] as RawOrder[]
        }),
        fetchDistributorBookings(startDate, endDate).catch((e) => {
          console.error('sales-attribution: fetchDistributorBookings:', e.message)
          return [] as RawOrder[]
        }),
      ])
      const allOrders = [...workshopOrders, ...distOrders]

      const data = analyze(quotesByRep, allOrders, startDate, endDate)

      cache.set(cacheKey, { data, timestamp: Date.now() })
      if (cache.size > 20) {
        const firstKey = cache.keys().next().value
        if (firstKey) cache.delete(firstKey)
      }

      return res.status(200).json(data)
    } catch (err: any) {
      console.error('sales-attribution handler error:', err.message)
      return res.status(500).json({ error: err.message || 'Attribution fetch failed' })
    }
  })
}
