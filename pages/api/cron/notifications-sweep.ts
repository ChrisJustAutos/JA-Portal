// pages/api/cron/notifications-sweep.ts
// Vercel cron (every 15 min) — emits notifications for events that live in
// Monday.com and therefore have NO insert point in this codebase:
//
//   1. New sales leads (the "Quote - Lead" group on each rep's quote board)
//      → the board's rep (matched by name) + admins/managers, module 'leads'.
//   2. New to-dos (each manager's "Hidden To Do" board)
//      → the board owner (matched by name), module 'todos'.
//
// "New" = item created within LOOKBACK_HOURS. Every emit carries a stable
// dedupe key (lead:<id> / todo:<id>), so re-sweeps of the same item are
// silent no-ops — the window only bounds how far back a first-ever sweep
// (or one after downtime) can flood.
//
// Auth: CRON_SECRET bearer (or the vercel-cron user-agent), mirroring the
// other crons. Board ids duplicated from pages/api/sales.ts / todos.ts —
// keep in sync if boards change.

import type { NextApiRequest, NextApiResponse } from 'next'
import { notify, findUserByName } from '../../../lib/notifications'

export const config = { maxDuration: 120 }

const MONDAY_TOKEN = process.env.MONDAY_API_TOKEN || ''
const MONDAY_URL = 'https://api.monday.com/v2'
const LOOKBACK_HOURS = 24
const PAGE_SIZE = 500
const MAX_PAGES = 4

const LEAD_GROUP_ID = 'topics' // "Quote - Lead" group on all quote boards
const QUOTE_BOARDS = [
  { rep: 'Tyronne', id: 5025942288 },
  { rep: 'James', id: 5025942292 },
  { rep: 'Dom', id: 5025942308 },
  { rep: 'Kaleb', id: 5025942316 },
  { rep: 'Graham', id: 5026840169 },
]
const TODO_BOARDS = [
  { owner: 'Chris', id: 1838427899 },
  { owner: 'Matt H', id: 2006328423 },
  { owner: 'Amanda', id: 2063839393 },
  { owner: 'Morgan', id: 2006328760 },
  { owner: 'Ryan', id: 1839578010 },
  { owner: 'Sam', id: 5024204351 },
]

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

// Page through a board (optionally one group), returning { id, name, created_at }.
async function fetchItems(boardId: number, groupId?: string): Promise<Array<{ id: string; name: string; created_at: string }>> {
  const sel = `cursor items { id name created_at }`
  const inner = groupId
    ? `groups(ids: ["${groupId}"]) { items_page(limit: ${PAGE_SIZE}) { ${sel} } }`
    : `items_page(limit: ${PAGE_SIZE}) { ${sel} }`
  const first = await mondayQuery(`{ boards(ids: [${boardId}]) { ${inner} } }`)
  const board = first?.boards?.[0]
  const firstPage = groupId ? board?.groups?.[0]?.items_page : board?.items_page
  const all: any[] = [...(firstPage?.items || [])]
  let cursor: string | null = firstPage?.cursor || null
  let pages = 1
  while (cursor && pages < MAX_PAGES) {
    const next = await mondayQuery(`{ next_items_page(limit: ${PAGE_SIZE}, cursor: "${cursor}") { ${sel} } }`)
    const page = next?.next_items_page
    if (!page) break
    all.push(...(page.items || []))
    cursor = page.cursor || null
    pages++
  }
  return all
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase()
  const authorized = cronSecret ? authHeader === `Bearer ${cronSecret}` : userAgent.includes('vercel-cron')
  if (!authorized) return res.status(401).json({ error: 'Unauthorised' })
  if (!MONDAY_TOKEN) return res.status(200).json({ ok: true, note: 'MONDAY_API_TOKEN not set — skipped' })

  const since = Date.now() - LOOKBACK_HOURS * 3600 * 1000
  const out = { leads: 0, todos: 0, errors: [] as string[] }

  // ── New leads ────────────────────────────────────────────────────────
  for (const board of QUOTE_BOARDS) {
    try {
      const items = (await fetchItems(board.id, LEAD_GROUP_ID))
        .filter(it => Date.parse(it.created_at) > since)
      if (!items.length) continue
      const repId = await findUserByName(board.rep)
      for (const it of items) {
        await notify({
          module: 'leads',
          title: `New lead — ${it.name}`,
          body: board.rep,
          href: '/sales',
          dedupeKey: `lead:${it.id}`,
          roles: ['admin', 'manager'],
          userIds: repId ? [repId] : [],
        })
        out.leads++
      }
    } catch (e: any) {
      out.errors.push(`leads/${board.rep}: ${e?.message || e}`)
    }
  }

  // ── New to-dos ───────────────────────────────────────────────────────
  for (const board of TODO_BOARDS) {
    try {
      const ownerId = await findUserByName(board.owner)
      if (!ownerId) continue // no matching portal user — nobody to notify
      const items = (await fetchItems(board.id))
        .filter(it => Date.parse(it.created_at) > since)
      for (const it of items) {
        await notify({
          module: 'todos',
          title: `New to-do — ${it.name}`,
          href: '/todos',
          dedupeKey: `todo:${it.id}`,
          userIds: [ownerId],
        })
        out.todos++
      }
    } catch (e: any) {
      out.errors.push(`todos/${board.owner}: ${e?.message || e}`)
    }
  }

  return res.status(200).json({ ok: true, ...out })
}
