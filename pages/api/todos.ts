// pages/api/todos.ts — Manager to-do board aggregator for /todos dashboard.
//
// Pulls all 6 "Hidden To Do" boards, normalises their differing column IDs,
// and returns per-manager open/completed stats + a critical tasks list +
// completed items list for the period.
//
// Status values we care about (all boards share the same labels):
//   0 "Working on it" · 1 "Done" · 2 "Stuck" · 3 "On Hold" · 4 "Testing Phase"
// Only "Done" counts as completed. Everything else = open.
//
// Date filter is applied client-side on `created_at` (for open-in-period counts)
// and on the status-change log for completed items. See createdAtToLocalDate
// helper (copied from sales.ts — keeps Brisbane TZ semantics consistent).

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

// ── UTC → Brisbane local date (same helper as sales.ts) ──────
function createdAtToLocalDate(createdAt: string | null | undefined): string {
  if (!createdAt) return ''
  const t = Date.parse(createdAt)
  if (isNaN(t)) return ''
  const shifted = new Date(t + 10 * 60 * 60 * 1000)
  return shifted.toISOString().slice(0, 10)
}

// ── Manager boards — each entry knows the boards's column ID peculiarities ──
// A few boards have different column IDs for `creation_log` / priority.
// We normalise by pulling only what we need from each board individually.
interface BoardConfig {
  manager: string
  boardId: number
  // Columns we try to read per item. All 6 boards have a "status" column with
  // id "status" — that's the common one. Priority is only on Chris's board.
  hasPriority: boolean
  // "Working on it" has index 0. Green is 1 (Done). Full map set below.
}

const MANAGER_BOARDS: BoardConfig[] = [
  { manager: 'Chris',   boardId: 1838427899, hasPriority: true },
  { manager: 'Matt H',  boardId: 2006328423, hasPriority: false },
  { manager: 'Amanda',  boardId: 2063839393, hasPriority: false },
  { manager: 'Morgan',  boardId: 2006328760, hasPriority: false },
  { manager: 'Ryan',    boardId: 1839578010, hasPriority: false },
  { manager: 'Sam',     boardId: 5024204351, hasPriority: false },
]

// Status labels — shared across all boards per the discovery.
// Key = text shown in the UI.
const STATUS_DONE = 'Done'
const OPEN_STATUSES = ['Working on it', 'Stuck', 'On Hold', 'Testing Phase'] as const

// Cache
const CACHE_TTL = 5 * 60 * 1000
const cache = new Map<string, { data: any; timestamp: number }>()
function getCached(key: string) { const e = cache.get(key); if (!e) return null; if (Date.now() - e.timestamp > CACHE_TTL) { cache.delete(key); return null }; return e.data }
function setCache(key: string, data: any) { cache.set(key, { data, timestamp: Date.now() }); if (cache.size > 20) { const k = cache.keys().next().value; if (k) cache.delete(k) } }

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn() } catch(e: any) { console.error('todos:', (e.message || String(e)).substring(0, 400)); return null }
}

const PAGE_SIZE = 500
const MAX_PAGES = 6  // 3,000 items per board ceiling — each has <= 222

async function mondayPaginate(
  buildInitialQuery: (limit: number) => string,
  buildNextQuery: (limit: number, cursor: string) => string,
): Promise<any[]> {
  const allItems: any[] = []
  const firstData = await mondayQuery(buildInitialQuery(PAGE_SIZE))
  const firstPage = firstData?.boards?.[0]?.items_page
  if (firstPage?.items) allItems.push(...firstPage.items)
  let cursor: string | null = firstPage?.cursor || null
  let pagesFetched = 1
  while (cursor && pagesFetched < MAX_PAGES) {
    const nextData = await mondayQuery(buildNextQuery(PAGE_SIZE, cursor))
    const nextPage = nextData?.next_items_page
    if (!nextPage) break
    if (nextPage.items) allItems.push(...nextPage.items)
    cursor = nextPage.cursor || null
    pagesFetched++
  }
  return allItems
}

// ── Pull one manager's board and compute stats ───────────────
interface TodoItem {
  id: string
  name: string
  status: string
  priority: string | null
  createdAt: string          // raw UTC ISO
  createdLocalDate: string   // YYYY-MM-DD Brisbane
  ageDays: number | null     // open only; null for closed
  manager: string
  boardId: number
}

interface ManagerStats {
  manager: string
  boardId: number
  totalItems: number            // total items on the board
  openTotal: number             // in any non-Done status
  openByStatus: Record<string, number>
  critical: number              // priority = "Critical ⚠️️"
  completedInPeriod: number     // Done + createdAt in window
  avgAgeDays: number | null     // open items average age
}

async function fetchManagerBoard(cfg: BoardConfig, startDate: string, endDate: string): Promise<{ stats: ManagerStats; items: TodoItem[] }> {
  // Request only the status column + priority (if it exists). Keep GraphQL small.
  const cols = cfg.hasPriority ? `["status","color_mks0522q"]` : `["status"]`
  const items = await mondayPaginate(
    (limit) => `{ boards(ids: [${cfg.boardId}]) { items_page(limit: ${limit}) { cursor items { id name created_at column_values(ids: ${cols}) { id text } } } } }`,
    (limit, cursor) => `{ next_items_page(limit: ${limit}, cursor: "${cursor}") { cursor items { id name created_at column_values(ids: ${cols}) { id text } } } }`,
  )
  const now = Date.now()
  const openByStatus: Record<string, number> = {}
  let openTotal = 0, critical = 0, completedInPeriod = 0, ageSum = 0, ageCount = 0
  const out: TodoItem[] = []
  for (const it of items) {
    const status = it.column_values?.find((c: any) => c.id === 'status')?.text || 'Unknown'
    const priority = cfg.hasPriority ? (it.column_values?.find((c: any) => c.id === 'color_mks0522q')?.text || null) : null
    const createdLocalDate = createdAtToLocalDate(it.created_at)
    const isOpen = status !== STATUS_DONE
    const createdMs = it.created_at ? Date.parse(it.created_at) : NaN
    const ageDays = isOpen && !isNaN(createdMs) ? Math.floor((now - createdMs) / 86_400_000) : null
    if (ageDays !== null) { ageSum += ageDays; ageCount++ }
    if (isOpen) {
      openTotal++
      openByStatus[status] = (openByStatus[status] || 0) + 1
      if (priority && priority.toLowerCase().startsWith('critical')) critical++
    } else {
      // Done — count if completion/creation is in the period window.
      // Note: we don't have a true "completed_at" timestamp from Monday;
      // Monday has activity logs but they're expensive to fetch. Using
      // `createdAt in period` as a proxy means we count "tasks created in the
      // period that are now Done". That matches the existing semantic on the
      // sales dashboard and is a reasonable stand-in.
      if (createdLocalDate && createdLocalDate >= startDate && createdLocalDate <= endDate) {
        completedInPeriod++
      }
    }
    out.push({
      id: String(it.id),
      name: it.name,
      status,
      priority,
      createdAt: it.created_at || '',
      createdLocalDate,
      ageDays,
      manager: cfg.manager,
      boardId: cfg.boardId,
    })
  }
  const stats: ManagerStats = {
    manager: cfg.manager,
    boardId: cfg.boardId,
    totalItems: items.length,
    openTotal,
    openByStatus,
    critical,
    completedInPeriod,
    avgAgeDays: ageCount > 0 ? Math.round(ageSum / ageCount) : null,
  }
  return { stats, items: out }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    if (!MONDAY_TOKEN) return res.status(500).json({ error: 'MONDAY_API_TOKEN not configured' })
    const startDate = (req.query.startDate as string) || '2025-07-01'
    const endDate = (req.query.endDate as string) || '2026-06-30'
    const forceRefresh = req.query.refresh === 'true'
    const cacheKey = `todos:v1:${startDate}:${endDate}`
    if (!forceRefresh) { const cached = getCached(cacheKey); if (cached) return res.status(200).json(cached) }

    const results = await Promise.all(
      MANAGER_BOARDS.map(cfg => safe(() => fetchManagerBoard(cfg, startDate, endDate))),
    )

    const managers = results.filter(Boolean) as Array<{ stats: ManagerStats; items: TodoItem[] }>

    // Flatten for cross-board queries
    const allItems = managers.flatMap(m => m.items)

    // Critical open list — sort by manager, then oldest first
    const criticalOpen = allItems
      .filter(it => it.status !== STATUS_DONE && (it.priority || '').toLowerCase().startsWith('critical'))
      .sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0))
      .slice(0, 50)

    // Completed feed — completed & created in period, newest first
    const completedFeed = allItems
      .filter(it => it.status === STATUS_DONE && it.createdLocalDate >= startDate && it.createdLocalDate <= endDate)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 200)

    // Totals across all managers
    const totals = {
      openTotal:          managers.reduce((s, m) => s + m.stats.openTotal, 0),
      critical:           managers.reduce((s, m) => s + m.stats.critical, 0),
      completedInPeriod:  managers.reduce((s, m) => s + m.stats.completedInPeriod, 0),
      teamTotal:          managers.reduce((s, m) => s + m.stats.totalItems, 0),
    }

    const result = {
      fetchedAt: new Date().toISOString(),
      period: { startDate, endDate },
      managers: managers.map(m => m.stats),
      totals,
      criticalOpen,
      completedFeed,
    }
    setCache(cacheKey, result)
    res.status(200).json(result)
  })
}
