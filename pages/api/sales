// pages/api/sales.ts — Monday.com data for Sales Dashboard
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'

export const config = { maxDuration: 30 }

const MONDAY_TOKEN = process.env.MONDAY_API_TOKEN || ''
const MONDAY_URL = 'https://api.monday.com/v2'

// ── Monday.com GraphQL helper ────────────────────────────────
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

async function safe(fn: () => Promise<any>) {
  try { return await fn() } catch(e: any) { console.error('sales:', e.message?.substring(0, 80)); return null }
}

// ── Board IDs ────────────────────────────────────────────────
const ORDERS_BOARD = 1838428097
const QUOTE_BOARDS = [
  { rep: 'Tyronne', full: 'Tyronne Wright', id: 5025942288 },
  { rep: 'James', full: 'James Wilson', id: 5025942292 },
  { rep: 'Dom', full: 'Dom Simpson', id: 5025942308 },
  { rep: 'Kaleb', full: 'Kaleb Rowe', id: 5025942316 },
  { rep: 'Graham', full: 'Graham', id: 5026840169 },
]
const DIST_BOOKING_BOARD = 1923220718

// ── Cache ────────────────────────────────────────────────────
const CACHE_TTL = 5 * 60 * 1000
const cache = new Map<string, { data: any; timestamp: number }>()
function getCached(key: string) { const e = cache.get(key); if (!e) return null; if (Date.now() - e.timestamp > CACHE_TTL) { cache.delete(key); return null }; return e.data }
function setCache(key: string, data: any) { cache.set(key, { data, timestamp: Date.now() }); if (cache.size > 20) { const k = cache.keys().next().value; if (k) cache.delete(k) } }

// ── Quote board aggregation via GraphQL ──────────────────────
async function getQuoteBoardStats(boardId: number) {
  // Get items grouped by status with values
  const data = await mondayQuery(`{
    boards(ids: [${boardId}]) {
      groups { id title }
      items_page(limit: 500) {
        items {
          group { id title }
          column_values(ids: ["status", "numeric_mkzcbhz2"]) {
            id
            text
            value
          }
        }
        cursor
      }
    }
  }`)
  const items = data?.boards?.[0]?.items_page?.items || []
  const stats: Record<string, { count: number; value: number }> = {}
  let totalValue = 0

  for (const item of items) {
    const status = item.column_values?.find((c: any) => c.id === 'status')?.text || 'Unknown'
    const valStr = item.column_values?.find((c: any) => c.id === 'numeric_mkzcbhz2')?.text
    const val = valStr ? parseFloat(valStr) : 0

    if (!stats[status]) stats[status] = { count: 0, value: 0 }
    stats[status].count++
    stats[status].value += val
    totalValue += val
  }

  return { stats, totalItems: items.length, totalValue }
}

// ── Orders board monthly summary ─────────────────────────────
async function getOrdersMonthly(startDate: string, endDate: string) {
  // Get done orders within date range
  const data = await mondayQuery(`{
    boards(ids: [${ORDERS_BOARD}]) {
      items_page(limit: 500, query_params: {
        rules: [
          { column_id: "date", compare_value: ["${startDate}", "${endDate}"], operator: between },
          { column_id: "status", compare_value: [1], operator: any_of }
        ],
        operator: and
      }) {
        items {
          column_values(ids: ["date", "numbers", "color_mks9wfk9"]) {
            id
            text
          }
        }
        cursor
      }
    }
  }`)

  const items = data?.boards?.[0]?.items_page?.items || []
  const monthly: Record<string, { orders: number; value: number }> = {}
  const byType: Record<string, { count: number; value: number }> = {}
  let totalOrders = 0
  let totalValue = 0

  for (const item of items) {
    const dateStr = item.column_values?.find((c: any) => c.id === 'date')?.text || ''
    const valStr = item.column_values?.find((c: any) => c.id === 'numbers')?.text
    const typeStr = item.column_values?.find((c: any) => c.id === 'color_mks9wfk9')?.text || 'Uncategorised'
    const val = valStr ? parseFloat(valStr.replace(/[,$]/g, '')) : 0

    if (dateStr) {
      const monthKey = dateStr.substring(0, 7) // YYYY-MM
      if (!monthly[monthKey]) monthly[monthKey] = { orders: 0, value: 0 }
      monthly[monthKey].orders++
      monthly[monthKey].value += val
    }

    if (!byType[typeStr]) byType[typeStr] = { count: 0, value: 0 }
    byType[typeStr].count++
    byType[typeStr].value += val
    totalOrders++
    totalValue += val
  }

  return { monthly, byType, totalOrders, totalValue }
}

// ── Distributor bookings ─────────────────────────────────────
async function getDistributorBookings(startDate: string, endDate: string) {
  const data = await mondayQuery(`{
    boards(ids: [${DIST_BOOKING_BOARD}]) {
      items_page(limit: 500) {
        items {
          column_values(ids: ["status", "status_1", "date_1", "numbers"]) {
            id
            text
          }
        }
      }
    }
  }`)

  const items = data?.boards?.[0]?.items_page?.items || []
  const byDistributor: Record<string, { count: number; value: number }> = {}
  const byStatus: Record<string, { count: number; value: number }> = {}
  const mtdByDist: Record<string, { count: number; value: number }> = {}
  let total = { count: 0, value: 0 }
  let mtdTotal = { count: 0, value: 0 }

  for (const item of items) {
    const status = item.column_values?.find((c: any) => c.id === 'status')?.text || 'Unknown'
    const dist = item.column_values?.find((c: any) => c.id === 'status_1')?.text || 'Unknown'
    const dateStr = item.column_values?.find((c: any) => c.id === 'date_1')?.text || ''
    const valStr = item.column_values?.find((c: any) => c.id === 'numbers')?.text
    const val = valStr ? parseFloat(valStr.replace(/[,$]/g, '')) : 0

    if (!byDistributor[dist]) byDistributor[dist] = { count: 0, value: 0 }
    byDistributor[dist].count++
    byDistributor[dist].value += val

    if (!byStatus[status]) byStatus[status] = { count: 0, value: 0 }
    byStatus[status].count++
    byStatus[status].value += val

    total.count++
    total.value += val

    // Check if within current date range for MTD
    if (dateStr >= startDate && dateStr <= endDate) {
      if (!mtdByDist[dist]) mtdByDist[dist] = { count: 0, value: 0 }
      mtdByDist[dist].count++
      mtdByDist[dist].value += val
      mtdTotal.count++
      mtdTotal.value += val
    }
  }

  return { byDistributor, byStatus, mtdByDist, total, mtdTotal }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    if (!MONDAY_TOKEN) {
      return res.status(500).json({ error: 'MONDAY_API_TOKEN not configured' })
    }

    const startDate = (req.query.startDate as string) || '2025-07-01'
    const endDate = (req.query.endDate as string) || '2026-06-30'
    const forceRefresh = req.query.refresh === 'true'
    const cacheKey = `sales:${startDate}:${endDate}`

    if (!forceRefresh) {
      const cached = getCached(cacheKey)
      if (cached) return res.status(200).json(cached)
    }

    // Fetch all data in parallel
    const [ordersData, distData, ...quoteResults] = await Promise.all([
      safe(() => getOrdersMonthly(startDate, endDate)),
      safe(() => getDistributorBookings(startDate, endDate)),
      ...QUOTE_BOARDS.map(b => safe(() => getQuoteBoardStats(b.id).then(stats => ({ ...b, ...stats })))),
    ])

    const result = {
      fetchedAt: new Date().toISOString(),
      period: { startDate, endDate },
      orders: ordersData,
      distributors: distData,
      quotes: quoteResults.filter(Boolean),
    }

    setCache(cacheKey, result)
    res.status(200).json(result)
  })
}
