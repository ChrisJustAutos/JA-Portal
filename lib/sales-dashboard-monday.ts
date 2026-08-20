// lib/sales-dashboard-monday.ts
//
// Data layer for Reports → Sales Dashboard — the portal rebuild of the Monday
// "Sales Dashboard" (2079976) over the five rep Quote Channel boards.
//
// Distinct from Reports → Sales Report, which counts ORDERS TAKEN (Monday
// Orders board + MechanicDesk). This one is the QUOTE PIPELINE: what is open,
// with whom, at what stage, and what converted.
//
// Two things about these boards that shape the whole module:
//
//   1. GROUP IDS DRIFT PER BOARD. Only the five original template groups
//      (topics, group_title, new_group__1, new_group, new_group860) are shared.
//      "Lead RLMNA", "Follow up RLMNA", "On Hold" and "Not issued" were added
//      per board after the fork and every board has its own ids — Kaleb's On
//      Hold is group_mm12crrx, Dom's is group_mm12q0j0. Groups are therefore
//      resolved BY TITLE at runtime, never by hardcoded id. (The GROUPS map in
//      lib/monday-followup only holds one board's ids and is right for the
//      shared five only — do not reuse it for reporting across boards.)
//
//   2. REP COMES FROM THE BOARD, NOT THE OWNER COLUMN. The Owner backfill of
//      2026-08-20 covered the ~704 ACTIVE quotes; historical Won/Lost items
//      have an empty Owner. Each board is a rep's channel, so the board is the
//      reliable attribution for history.
//
// The columns needed here ARE shared across all five boards (verified
// 2026-08-21): numeric_mkzcbhz2 Quote Value (titled "Value" on James's board,
// same id), date4 Date, status Status, person Owner. The ones that drift
// (Distributor, Qualifying Stage, Contact Attempts, FU Stage, Quote No) are
// not read here.

import { REP_BOARDS } from './monday-followup'

const MONDAY_API = 'https://api.monday.com/v2'

const COL = {
  value: 'numeric_mkzcbhz2',
  date: 'date4',
  status: 'status',
  owner: 'person',
}

/** Canonical stage names, in pipeline order. Titles are matched with the
 *  "Quote - " prefix stripped, case-insensitively. */
export const OPEN_STAGES = ['Lead', 'Lead RLMNA', 'Follow Up', 'Follow up RLMNA', 'Pending', 'On Hold'] as const
const WON_TITLE = 'won'
const LOST_TITLE = 'lost'
const NOT_ISSUED_TITLE = 'not issued'

export interface StageBucket { stage: string; count: number; value: number }
export interface RepRow {
  rep: string; boardId: string
  openCount: number; openValue: number
  wonCount: number; wonValue: number
  lostCount: number; lostValue: number
  winRatePct: number | null
}
export interface MonthlyRow { month: string; wonCount: number; wonValue: number; lostCount: number; lostValue: number }
export interface AgeBucket { label: string; count: number; value: number }
export interface SalesDashboardData {
  period: { since: string; until: string; months: number }
  stages: StageBucket[]
  openTotal: { count: number; value: number }
  ageBuckets: AgeBucket[]
  reps: RepRow[]
  monthly: MonthlyRow[]
  totals: { wonCount: number; wonValue: number; lostCount: number; lostValue: number; winRatePct: number | null }
  /** Groups on a board that aren't part of the standard pipeline (Kaleb has a
   *  "Farm Fest 2026 booked in Jobs" group). Surfaced rather than silently
   *  folded away, so the numbers can always be reconciled to the boards. */
  unknownGroups: { rep: string; title: string; count: number; value: number }[]
  generatedAt: string
}

async function mondayQuery(token: string, query: string): Promise<any> {
  const r = await fetch(MONDAY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2024-10' },
    body: JSON.stringify({ query }),
  })
  const j = await r.json()
  if (j.errors) throw new Error(`Monday: ${JSON.stringify(j.errors).slice(0, 300)}`)
  return j.data
}

const num = (s: string | null | undefined): number => {
  const n = parseFloat(String(s ?? '').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}
const colText = (item: any, id: string): string | null =>
  (item.column_values || []).find((c: any) => c.id === id)?.text?.trim() || null

/** "Quote - Follow up RLMNA" → "follow up rlmna" */
const normTitle = (t: string) => t.replace(/^quote\s*-\s*/i, '').trim().toLowerCase()

interface BoardGroups { boardId: string; rep: string; byTitle: Map<string, string>; all: { id: string; title: string }[] }

async function resolveGroups(token: string): Promise<BoardGroups[]> {
  const ids = Object.values(REP_BOARDS).map(b => b.boardId).join(', ')
  const data = await mondayQuery(token, `query { boards(ids: [${ids}]) { id groups { id title } } }`)
  const boards: any[] = data?.boards || []
  return boards.map(b => {
    const rep = Object.values(REP_BOARDS).find(r => r.boardId === String(b.id))?.repName || `Board ${b.id}`
    const all = (b.groups || []).map((g: any) => ({ id: String(g.id), title: String(g.title) }))
    return {
      boardId: String(b.id), rep, all,
      byTitle: new Map(all.map((g: { id: string; title: string }) => [normTitle(g.title), g.id])),
    }
  })
}

async function pullItems(token: string, boardId: string, rules: string): Promise<any[]> {
  const colIds = Object.values(COL).map(c => `"${c}"`).join(',')
  const out: any[] = []
  let cursor: string | null = null
  // 20 pages × 500 = 10,000 items per board — the largest board holds ~1,500,
  // so this is a runaway guard, not a real cap.
  for (let page = 0; page < 20; page++) {
    const arg: string = cursor ? `cursor: "${cursor}"` : `query_params: { rules: [${rules}] }`
    const data = await mondayQuery(token, `query { boards(ids: [${boardId}]) {
      items_page(limit: 500, ${arg}) {
        cursor
        items { id name group { id title } column_values(ids: [${colIds}]) { id text } }
      }
    } }`)
    const pageData = data?.boards?.[0]?.items_page
    const items: any[] = pageData?.items || []
    out.push(...items)
    cursor = pageData?.cursor || null
    if (!cursor || !items.length) break
  }
  return out
}

function monthKey(iso: string): string { return iso.slice(0, 7) }

export async function fetchSalesDashboard(
  token: string, opts: { months?: number; now?: Date } = {},
): Promise<SalesDashboardData> {
  const months = Math.min(24, Math.max(1, opts.months ?? 12))
  const now = opts.now ?? new Date()
  const until = now.toISOString().slice(0, 10)
  const sinceDate = new Date(now)
  sinceDate.setMonth(sinceDate.getMonth() - months)
  const since = sinceDate.toISOString().slice(0, 10)

  const boards = await resolveGroups(token)

  const stageTotals = new Map<string, StageBucket>()
  const ageTotals: AgeBucket[] = [
    { label: '0–7 days', count: 0, value: 0 },
    { label: '8–30 days', count: 0, value: 0 },
    { label: '31–90 days', count: 0, value: 0 },
    { label: '90+ days', count: 0, value: 0 },
    { label: 'No date', count: 0, value: 0 },
  ]
  const monthly = new Map<string, MonthlyRow>()
  const unknownGroups: SalesDashboardData['unknownGroups'] = []
  const reps: RepRow[] = []

  for (const board of boards) {
    const won = board.byTitle.get(WON_TITLE)
    const lost = board.byTitle.get(LOST_TITLE)
    const notIssued = board.byTitle.get(NOT_ISSUED_TITLE)
    // Open = everything that isn't a closed bucket. Defined by exclusion so a
    // group nobody told us about still shows up rather than vanishing.
    const closed = new Set([won, lost, notIssued].filter(Boolean) as string[])
    const openIds = board.all.filter(g => !closed.has(g.id)).map(g => g.id)

    const quote = (ids: string[]) => ids.map(i => `"${i}"`).join(', ')

    const openItems = openIds.length
      ? await pullItems(token, board.boardId, `{ column_id: "group", compare_value: [${quote(openIds)}], operator: any_of }`)
      : []
    const closedItems = (won || lost)
      ? await pullItems(token, board.boardId,
          `{ column_id: "group", compare_value: [${quote([won, lost].filter(Boolean) as string[])}], operator: any_of }, ` +
          `{ column_id: "${COL.date}", compare_value: ["${since}", "${until}"], operator: between }`)
      : []

    const rep: RepRow = {
      rep: board.rep, boardId: board.boardId,
      openCount: 0, openValue: 0, wonCount: 0, wonValue: 0, lostCount: 0, lostValue: 0, winRatePct: null,
    }

    for (const it of openItems) {
      const value = num(colText(it, COL.value))
      const title = normTitle(String(it.group?.title || ''))
      const canonical = OPEN_STAGES.find(s => s.toLowerCase() === title)
      const stage = canonical || String(it.group?.title || 'Unknown')
      if (!canonical) {
        const seen = unknownGroups.find(u => u.rep === board.rep && u.title === stage)
        if (seen) { seen.count++; seen.value += value } else { unknownGroups.push({ rep: board.rep, title: stage, count: 1, value }) }
      }
      const b = stageTotals.get(stage) || { stage, count: 0, value: 0 }
      b.count++; b.value += value
      stageTotals.set(stage, b)

      rep.openCount++; rep.openValue += value

      const d = colText(it, COL.date)
      if (!d) { ageTotals[4].count++; ageTotals[4].value += value }
      else {
        const days = Math.floor((now.getTime() - Date.parse(d + 'T00:00:00Z')) / 86400000)
        const idx = days <= 7 ? 0 : days <= 30 ? 1 : days <= 90 ? 2 : 3
        ageTotals[idx].count++; ageTotals[idx].value += value
      }
    }

    for (const it of closedItems) {
      const value = num(colText(it, COL.value))
      const isWon = String(it.group?.id) === won
      const d = colText(it, COL.date)
      if (isWon) { rep.wonCount++; rep.wonValue += value } else { rep.lostCount++; rep.lostValue += value }
      if (d) {
        const k = monthKey(d)
        const m = monthly.get(k) || { month: k, wonCount: 0, wonValue: 0, lostCount: 0, lostValue: 0 }
        if (isWon) { m.wonCount++; m.wonValue += value } else { m.lostCount++; m.lostValue += value }
        monthly.set(k, m)
      }
    }

    const decided = rep.wonCount + rep.lostCount
    rep.winRatePct = decided > 0 ? (rep.wonCount / decided) * 100 : null
    reps.push(rep)
  }

  // Stages in pipeline order, unknown groups appended after.
  const ordered: StageBucket[] = []
  for (const s of OPEN_STAGES) { const b = stageTotals.get(s); if (b) ordered.push(b) }
  stageTotals.forEach((b, k) => { if (!OPEN_STAGES.some(s => s === k)) ordered.push(b) })

  const totals = reps.reduce(
    (a, r) => ({
      wonCount: a.wonCount + r.wonCount, wonValue: a.wonValue + r.wonValue,
      lostCount: a.lostCount + r.lostCount, lostValue: a.lostValue + r.lostValue,
    }),
    { wonCount: 0, wonValue: 0, lostCount: 0, lostValue: 0 },
  )
  const decided = totals.wonCount + totals.lostCount

  return {
    period: { since, until, months },
    stages: ordered,
    openTotal: {
      count: ordered.reduce((a, b) => a + b.count, 0),
      value: ordered.reduce((a, b) => a + b.value, 0),
    },
    ageBuckets: ageTotals.filter(b => b.count > 0),
    reps: reps.sort((a, b) => b.wonValue - a.wonValue),
    monthly: Array.from(monthly.values()).sort((a, b) => a.month.localeCompare(b.month)),
    totals: { ...totals, winRatePct: decided > 0 ? (totals.wonCount / decided) * 100 : null },
    unknownGroups,
    generatedAt: new Date().toISOString(),
  }
}
