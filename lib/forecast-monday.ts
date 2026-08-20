// lib/forecast-monday.ts
//
// Data layer for Reports → Forecast — the portal rebuild of the Monday
// "Forecast Dashboard - Includes JAWS" (dashboard 349826), which sits on the
// Monday "Forecasting" board (1842188200).
//
// Board shape (confirmed against live data 2026-08-21):
//   • 12 groups, one per calendar month (January … December).
//   • Two items per month — one for each entity: the workshop/retail side
//     (labelled VPS) and the wholesale side (JAWS).
//   • Turnover columns for 2024 / 2025 / 2026 side by side, plus a
//     hand-maintained "% Increase/Decrease" column and "Updated By:".
//
// Two traps in the real data, both handled here:
//   1. ITEM NAMES ARE UNRELIABLE for the month. The December group contains an
//      item titled "November Job Report - JAWS", March's is "Mach Job Report"
//      (typo), and August/September's are just "JAWS". The month therefore
//      comes from the GROUP, never the item title.
//   2. The hand-entered "% Increase/Decrease" column is sparse and
//      inconsistent (populated on a handful of JAWS rows only). It is carried
//      through for reference but every percentage the report SHOWS is computed
//      from the turnover figures.
//
// Pure Monday aggregation — no portal/DB dependencies.

const MONDAY_API = 'https://api.monday.com/v2'

export const FORECAST_BOARD = '1842188200'

// Column ids on the Forecasting board.
const COL = {
  y2024: 'numbers',
  y2025: 'numbers5',
  y2026: 'numeric_mkx6tb7p',
  pct: 'numbers4',
  updatedBy: 'multiple_person_mkspy75q',
}

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

export type ForecastEntity = 'VPS' | 'JAWS'

/** One board row: a single entity's turnover for a single month. */
export interface ForecastRow {
  month: string
  monthIndex: number
  entity: ForecastEntity
  itemId: string
  itemName: string
  years: Record<string, number | null>
  /** The board's hand-entered % column — reference only, never displayed as the change. */
  statedPct: number | null
  updatedBy: string | null
}

/** A month with each entity resolved and the combined total per year. */
export interface ForecastMonth {
  month: string
  monthIndex: number
  /** Turnover per year, keyed by year string, per entity plus combined. */
  vps: Record<string, number | null>
  jaws: Record<string, number | null>
  combined: Record<string, number | null>
  /** True once this month is wholly in the past for the current year. */
  complete: boolean
  /** True for the month currently in progress — its figure is partial. */
  inProgress: boolean
}

export interface ForecastData {
  years: string[]
  /** The year the report treats as "now" (the latest column with data). */
  currentYear: string
  priorYear: string
  months: ForecastMonth[]
  rows: ForecastRow[]
  /** Last completed month index (0-11) — the cut-off for like-for-like totals. */
  lastCompleteMonthIndex: number
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

const num = (s: string | null | undefined): number | null => {
  const raw = String(s ?? '').replace(/[^0-9.-]/g, '')
  if (!raw) return null
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : null
}

const colText = (item: any, id: string): string | null =>
  (item.column_values || []).find((c: any) => c.id === id)?.text?.trim() || null

/**
 * Entity from the item name. Anything mentioning JAWS is wholesale; everything
 * else is the VPS/workshop row. Deliberately loose — the titles vary wildly
 * ("JAWS", "October Job Report - JAWS", "April ALL Invoice Report Total (JAWS)").
 */
function entityOf(name: string): ForecastEntity {
  return /jaws/i.test(name) ? 'JAWS' : 'VPS'
}

/** Sum that preserves "no data at all" as null rather than reporting it as $0. */
function sumOrNull(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null
  return (a ?? 0) + (b ?? 0)
}

export async function fetchForecast(token: string, now: Date = new Date()): Promise<ForecastData> {
  const colIds = Object.values(COL).map(c => `"${c}"`).join(',')
  const data = await mondayQuery(token, `query { boards(ids: [${FORECAST_BOARD}]) {
    items_page(limit: 100) {
      items { id name group { title } column_values(ids: [${colIds}]) { id text } }
    }
  } }`)

  const items: any[] = data?.boards?.[0]?.items_page?.items || []
  const years = ['2024', '2025', '2026']

  const rows: ForecastRow[] = items.map(it => {
    const groupTitle = String(it.group?.title || '').trim()
    const monthIndex = MONTHS.findIndex(m => m.toLowerCase() === groupTitle.toLowerCase())
    return {
      month: monthIndex >= 0 ? MONTHS[monthIndex] : groupTitle,
      monthIndex,
      entity: entityOf(String(it.name || '')),
      itemId: String(it.id),
      itemName: String(it.name || ''),
      years: {
        '2024': num(colText(it, COL.y2024)),
        '2025': num(colText(it, COL.y2025)),
        '2026': num(colText(it, COL.y2026)),
      },
      statedPct: num(colText(it, COL.pct)),
      updatedBy: colText(it, COL.updatedBy),
    }
  }).filter(r => r.monthIndex >= 0)

  const months: ForecastMonth[] = MONTHS.map((month, monthIndex) => {
    const inMonth = rows.filter(r => r.monthIndex === monthIndex)
    const pick = (e: ForecastEntity): Record<string, number | null> => {
      const r = inMonth.find(x => x.entity === e)
      return Object.fromEntries(years.map(y => [y, r?.years[y] ?? null]))
    }
    const vps = pick('VPS')
    const jaws = pick('JAWS')
    return {
      month, monthIndex, vps, jaws,
      combined: Object.fromEntries(years.map(y => [y, sumOrNull(vps[y], jaws[y])])),
      complete: monthIndex < now.getMonth(),
      inProgress: monthIndex === now.getMonth(),
    }
  })

  const currentYear = String(now.getFullYear())
  return {
    years,
    currentYear: years.includes(currentYear) ? currentYear : years[years.length - 1],
    priorYear: String(Number(currentYear) - 1),
    months,
    rows,
    // Months strictly before the current one are the only like-for-like basis:
    // the in-progress month is partial, and future months on this board hold
    // forward bookings rather than turnover, so comparing them to a full prior
    // year would understate the business badly.
    lastCompleteMonthIndex: now.getMonth() - 1,
    generatedAt: new Date().toISOString(),
  }
}

/** Year-on-year change, null when either side is missing or the base is zero. */
export function pctChange(current: number | null, prior: number | null): number | null {
  if (current == null || prior == null || prior === 0) return null
  return ((current - prior) / prior) * 100
}

/** Total a year across months [0..throughIndex]; null if nothing is populated. */
export function totalThrough(
  months: ForecastMonth[], series: 'vps' | 'jaws' | 'combined', year: string, throughIndex: number,
): number | null {
  let sum = 0
  let any = false
  for (const m of months) {
    if (m.monthIndex > throughIndex) break
    const v = m[series][year]
    if (v != null) { sum += v; any = true }
  }
  return any ? sum : null
}
