// lib/reports/monday-fetcher.ts
// SERVER-ONLY. Calls the existing /api/sales endpoint internally to reuse
// all the Monday.com business logic (caching, auth, data shapes).
//
// We proxy a server-to-server fetch because:
//  1. The existing /api/sales endpoint already knows how to query Monday
//     with all the right board IDs, column mappings, and rep configs.
//  2. It has a 5-minute in-memory cache — if the user recently viewed
//     /sales, the report gets that cache for free.
//  3. Any future changes to Monday integration flow through one place.

import type { IncomingMessage } from 'http'

export interface MondaySalesData {
  fetchedAt: string
  period: { startDate: string; endDate: string }
  orders: {
    monthly: Record<string, { orders: number; value: number }>
    byType: Record<string, { count: number; value: number }>
    totalOrders: number
    totalValue: number
  } | null
  distributors: any
  quotes: Array<{
    rep: string
    full: string
    id: number
    stats: Record<string, { count: number; value: number }>
    totalItems: number
  }>
  activeLeads: Array<{
    id: string
    name: string
    url: string
    rep: string
    repFull: string
    phone: string
    status: string
    quoteValue: string
    date: string
    qualifyingStage: string
    contactAttempts: string
  }>
}

// Build the correct base URL for internal server-to-server fetch.
// On Vercel we have VERCEL_URL populated; fall back to localhost for dev.
function getInternalBaseUrl(): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL
  return 'http://localhost:3000'
}

// Fetch with the original user's auth cookie forwarded so /api/sales
// passes its requireAuth() check.
export async function fetchMondaySalesData(
  req: IncomingMessage,
  startDate: string,
  endDate: string,
): Promise<MondaySalesData | null> {
  const baseUrl = getInternalBaseUrl()
  const cookie = req.headers.cookie || ''
  const url = `${baseUrl}/api/sales?startDate=${startDate}&endDate=${endDate}`
  try {
    const res = await fetch(url, {
      headers: { cookie },
      // Server-to-server fetch — don't follow caching that the browser would use
      cache: 'no-store',
    })
    if (!res.ok) {
      console.error(`Monday sales fetch failed: ${res.status}`)
      return null
    }
    return await res.json()
  } catch (err: any) {
    console.error('Monday sales fetch error:', err.message)
    return null
  }
}
