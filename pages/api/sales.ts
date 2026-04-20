// pages/api/sales.ts — Monday.com data for Sales Dashboard
//
// GST NOTE: This route pulls $ values from Monday.com numeric fields (orders
// totalValue, quote value, distributor booking amount). These are values that
// reps entered manually in Monday.com — we have no metadata indicating whether
// they're inc-GST or ex-GST. The portal surfaces them verbatim.
// If your sales team enters quote values inc-GST in Monday.com, the numbers
// here will be inc-GST regardless of the user's ex/inc GST preference.
// Fixing this properly requires a convention agreement with the sales team
// (or a column in Monday.com to flag GST treatment per line).

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'

export const config = { maxDuration: 45 }

const MONDAY_TOKEN = process.env.MONDAY_API_TOKEN || ''
const MONDAY_URL = 'https://api.monday.com/v2'

async function mondayQuery(query: string) {
  const res = await fetch(MONDAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': MONDAY_TOKEN, 'API-Version': '2024-10' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`Monday API ${res.status}`)
  const data = await res.json()
  if (data.errors) throw new Error(data.errors[0]?.message || 'Monday API error')
  return data.data
}

async function safe(fn: () => Promise<any>) {
  try { return await fn() } catch(e: any) { console.error('sales:', e.message?.substring(0, 80)); return null }
}

const ORDERS_BOARD = 1838428097
const QUOTE_BOARDS = [
  { rep: 'Tyronne', full: 'Tyronne Wright', id: 5025942288, qualCol: 'text_mm1jbtjp', contactCol: 'numeric_mm12e9mz' },
  { rep: 'James', full: 'James Wilson', id: 5025942292, qualCol: 'text_mm1j80th', contactCol: 'numeric_mm12hfbc' },
  { rep: 'Dom', full: 'Dom Simpson', id: 5025942308, qualCol: 'text_mm1jbtjp', contactCol: 'numeric_mm12e9mz' },
  { rep: 'Kaleb', full: 'Kaleb Rowe', id: 5025942316, qualCol: 'text_mm1jbtjp', contactCol: 'numeric_mm12e9mz' },
  { rep: 'Graham', full: 'Graham', id: 5026840169, qualCol: 'text_mm1jbtjp', contactCol: 'numeric_mm12e9mz' },
]
const DIST_BOOKING_BOARD = 1923220718
const LEAD_GROUP_ID = 'topics' // "Quote - Lead" group on all boards

// Cache
const CACHE_TTL = 5 * 60 * 1000
const cache = new Map<string, { data: any; timestamp: number }>()
function getCached(key: string) { const e = cache.get(key); if (!e) return null; if (Date.now() - e.timestamp > CACHE_TTL) { cache.delete(key); return null }; return e.data }
function setCache(key: string, data: any) { cache.set(key, { data, timestamp: Date.now() }); if (cache.size > 20) { const k = cache.keys().next().value; if (k) cache.delete(k) } }

// ── Quote board stats ────────────────────────────────────────
async function getQuoteBoardStats(boardId: number) {
  const data = await mondayQuery(`{ boards(ids: [${boardId}]) { items_page(limit: 500) { items { column_values(ids: ["status", "numeric_mkzcbhz2"]) { id text } } } } }`)
  const items = data?.boards?.[0]?.items_page?.items || []
  const stats: Record<string, { count: number; value: number }> = {}
  for (const item of items) {
    const status = item.column_values?.find((c: any) => c.id === 'status')?.text || 'Unknown'
    const valStr = item.column_values?.find((c: any) => c.id === 'numeric_mkzcbhz2')?.text
    const val = valStr ? parseFloat(valStr) : 0
    if (!stats[status]) stats[status] = { count: 0, value: 0 }
    stats[status].count++; stats[status].value += val
  }
  return { stats, totalItems: items.length }
}

// ── Active leads from "Quote - Lead" group ───────────────────
async function getActiveLeads(board: typeof QUOTE_BOARDS[0]) {
  const cols = `"name", "text_mkzbenay", "status", "numeric_mkzcbhz2", "date4", "${board.qualCol}", "${board.contactCol}"`
  const data = await mondayQuery(`{
    boards(ids: [${board.id}]) {
      groups(ids: ["${LEAD_GROUP_ID}"]) {
        items_page(limit: 100) {
          items {
            id name url
            column_values(ids: [${cols}]) { id text }
          }
        }
      }
    }
  }`)
  const items = data?.boards?.[0]?.groups?.[0]?.items_page?.items || []
  return items.map((item: any) => ({
    id: item.id,
    name: item.name,
    url: item.url,
    rep: board.rep,
    repFull: board.full,
    phone: item.column_values?.find((c: any) => c.id === 'text_mkzbenay')?.text || '',
    status: item.column_values?.find((c: any) => c.id === 'status')?.text || '',
    quoteValue: item.column_values?.find((c: any) => c.id === 'numeric_mkzcbhz2')?.text || '',
    date: item.column_values?.find((c: any) => c.id === 'date4')?.text || '',
    qualifyingStage: item.column_values?.find((c: any) => c.id === board.qualCol)?.text || '',
    contactAttempts: item.column_values?.find((c: any) => c.id === board.contactCol)?.text || '0',
  }))
}

// ── Orders monthly ───────────────────────────────────────────
// Status column "Parts Ordered" on the Orders board. Index mapping:
//   0 Deleted  1 Done  2 Re Scheduled  3 Modified  4 Canceled  5 Not Done  6 Postponed
// Workshop wants "current + processed" = everything except Deleted + Canceled.
const WORKSHOP_ORDER_STATUSES = [1, 2, 3, 5, 6]

async function getOrdersMonthly(startDate: string, endDate: string) {
  const statusList = WORKSHOP_ORDER_STATUSES.join(',')
  const data = await mondayQuery(`{ boards(ids: [${ORDERS_BOARD}]) { items_page(limit: 500, query_params: { rules: [{ column_id: "date", compare_value: ["${startDate}", "${endDate}"], operator: between },{ column_id: "status", compare_value: [${statusList}], operator: any_of }], operator: and }) { items { column_values(ids: ["date", "numbers", "color_mks9wfk9"]) { id text } } } } }`)
  const items = data?.boards?.[0]?.items_page?.items || []
  const monthly: Record<string, { orders: number; value: number }> = {}
  const byType: Record<string, { count: number; value: number }> = {}
  let totalOrders = 0, totalValue = 0
  for (const item of items) {
    const dateStr = item.column_values?.find((c: any) => c.id === 'date')?.text || ''
    const valStr = item.column_values?.find((c: any) => c.id === 'numbers')?.text
    const typeStr = item.column_values?.find((c: any) => c.id === 'color_mks9wfk9')?.text || 'Uncategorised'
    const val = valStr ? parseFloat(valStr.replace(/[,$]/g, '')) : 0
    if (dateStr) { const mk = dateStr.substring(0, 7); if (!monthly[mk]) monthly[mk] = { orders: 0, value: 0 }; monthly[mk].orders++; monthly[mk].value += val }
    if (!byType[typeStr]) byType[typeStr] = { count: 0, value: 0 }; byType[typeStr].count++; byType[typeStr].value += val
    totalOrders++; totalValue += val
  }
  return { monthly, byType, totalOrders, totalValue }
}

// ── Distributor bookings ─────────────────────────────────────
// Status column on Distributor-Booking board. Index mapping:
//   0 Required  1 Confirmed  2 Cancelled  3 Follow Up RLMNA
//   4 Follow Up Done/Completed  5 Pending  6 Postponed
// Business rule: Include active work — Required + Confirmed + Follow Up RLMNA + Pending.
// Excludes Cancelled, Follow Up Done/Completed, and Postponed.
// Filter applied server-side via Monday query_params for efficiency.
const DISTRIBUTOR_ACTIVE_STATUSES = [0, 1, 3, 5]

async function getDistributorBookings(startDate: string, endDate: string) {
  const statusList = DISTRIBUTOR_ACTIVE_STATUSES.join(',')
  const data = await mondayQuery(`{ boards(ids: [${DIST_BOOKING_BOARD}]) { items_page(limit: 500, query_params: { rules: [{ column_id: "status", compare_value: [${statusList}], operator: any_of }] }) { items { column_values(ids: ["status", "status_1", "date_1", "numbers", "person"]) { id text } } } } }`)
  const items = data?.boards?.[0]?.items_page?.items || []
  const byDistributor: Record<string, { count: number; value: number }> = {}
  const byStatus: Record<string, { count: number; value: number }> = {}
  const byPerson: Record<string, { count: number; value: number }> = {}
  const mtdByDist: Record<string, { count: number; value: number }> = {}
  const mtdByPerson: Record<string, { count: number; value: number }> = {}
  let total = { count: 0, value: 0 }, mtdTotal = { count: 0, value: 0 }
  for (const item of items) {
    const status = item.column_values?.find((c: any) => c.id === 'status')?.text || 'Unknown'
    const dist = item.column_values?.find((c: any) => c.id === 'status_1')?.text || 'Unknown'
    const dateStr = item.column_values?.find((c: any) => c.id === 'date_1')?.text || ''
    const valStr = item.column_values?.find((c: any) => c.id === 'numbers')?.text
    const person = item.column_values?.find((c: any) => c.id === 'person')?.text || 'Unassigned'
    const val = valStr ? parseFloat(valStr.replace(/[,$]/g, '')) : 0
    if (!byDistributor[dist]) byDistributor[dist] = { count: 0, value: 0 }; byDistributor[dist].count++; byDistributor[dist].value += val
    if (!byStatus[status]) byStatus[status] = { count: 0, value: 0 }; byStatus[status].count++; byStatus[status].value += val
    if (!byPerson[person]) byPerson[person] = { count: 0, value: 0 }; byPerson[person].count++; byPerson[person].value += val
    total.count++; total.value += val
    if (dateStr >= startDate && dateStr <= endDate) {
      if (!mtdByDist[dist]) mtdByDist[dist] = { count: 0, value: 0 }; mtdByDist[dist].count++; mtdByDist[dist].value += val
      if (!mtdByPerson[person]) mtdByPerson[person] = { count: 0, value: 0 }; mtdByPerson[person].count++; mtdByPerson[person].value += val
      mtdTotal.count++; mtdTotal.value += val
    }
  }
  return { byDistributor, byStatus, byPerson, mtdByDist, mtdByPerson, total, mtdTotal }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    if (!MONDAY_TOKEN) return res.status(500).json({ error: 'MONDAY_API_TOKEN not configured' })
    const startDate = (req.query.startDate as string) || '2025-07-01'
    const endDate = (req.query.endDate as string) || '2026-06-30'
    const forceRefresh = req.query.refresh === 'true'
    const cacheKey = `sales:${startDate}:${endDate}`
    if (!forceRefresh) { const cached = getCached(cacheKey); if (cached) return res.status(200).json(cached) }

    const [ordersData, distData, ...rest] = await Promise.all([
      safe(() => getOrdersMonthly(startDate, endDate)),
      safe(() => getDistributorBookings(startDate, endDate)),
      ...QUOTE_BOARDS.map(b => safe(() => getQuoteBoardStats(b.id).then(stats => ({ rep: b.rep, full: b.full, id: b.id, ...stats })))),
      ...QUOTE_BOARDS.map(b => safe(() => getActiveLeads(b))),
    ])

    // Split rest into quote stats and active leads
    const quoteResults = rest.slice(0, QUOTE_BOARDS.length).filter(Boolean)
    const leadsArrays = rest.slice(QUOTE_BOARDS.length).filter(Boolean)
    const activeLeads = ([] as any[]).concat(...leadsArrays)

    const result = { fetchedAt: new Date().toISOString(), period: { startDate, endDate }, orders: ordersData, distributors: distData, quotes: quoteResults, activeLeads }
    setCache(cacheKey, result)
    res.status(200).json(result)
  })
}
