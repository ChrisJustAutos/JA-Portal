// lib/sales-recap.ts
//
// Weekly Sales Recap assembler. Given year-to-date Monday orders/distributor
// rows + the MechanicDesk diary notes & forward forecast (scraped by the
// GH-Actions runner), builds the six-section data model that matches the
// source doc. Pure — no I/O — so it's unit-testable and runs anywhere.

import {
  dailyBreakdown, windowTotals, monthlyBreakdown,
  type OrderRow, type DistRow, type DailyRow, type MonthRow, type QuoteLeadRow,
} from './sales-recap-monday'

export const DAILY_TARGET = 60000

export interface RecapWeek { start: string; end: string } // Mon..Fri YMD

export interface WeekComparisonRow {
  label: string; start: string; end: string
  orders: number; distributor: number; total: number
  tradingDays: number; dailyAvg: number
}
export interface DiaryNoteOut { content: string; start: string | null; end: string | null; scope: 'office' | 'workshop' | 'all' }
export interface ForecastMonthOut { month: string; label: string; value: number; jobCount: number }
export interface FlagOut { priority: 'HIGH' | 'MED' | 'INFO'; item: string }
export interface OvernightLeadOut { channel: string; name: string; phone: string | null; createdAt: string }
export interface OvernightOut { start: string; end: string; label: string; leads: OvernightLeadOut[] }
// Everything posted in the negative-feedback Slack channel over the report
// period (#customer-feedback-negative — concern automation cards AND manual
// staff posts alike). `author` is null for bot posts (the text carries the
// advisor's voice already).
export interface NegativeFeedbackItem { at: string; author: string | null; text: string }
export interface NegativeFeedbackOut { start: string; end: string; label: string; items: NegativeFeedbackItem[] }

export interface SalesRecap {
  week: RecapWeek
  generatedAt: string
  dailyTarget: number
  // Section 1
  daily: DailyRow[]
  weekTotal: { orders: number; distributor: number; total: number; tradingDaysWithData: number; dailyAvg: number }
  // Section 2
  rolling: WeekComparisonRow[]
  // Section 3
  monthly: MonthRow[]
  // Section 4
  diaryNotes: DiaryNoteOut[]
  // Section 5
  forecast: ForecastMonthOut[]
  // Section 6
  flags: FlagOut[]
  // Overnight quote-channel leads (5:30pm last trading day → 7:00am). Null on
  // reports assembled without a quote-lead pull (older stored recaps).
  overnight: OvernightOut | null
  // Negative Slack-channel posts for the period. Null when the pull wasn't
  // supplied / failed (older stored recaps render without the section).
  negativeFeedback?: NegativeFeedbackOut | null
}

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const AU_TZ_OFFSET_MS = 10 * 3600 * 1000
function brisbaneNow(nowMs: number): Date { return new Date(nowMs + AU_TZ_OFFSET_MS) }

// The Monday..Friday of the week that just ENDED before `asOfMs` (Brisbane).
// Run Monday 7am → recaps the previous trading week.
export function previousTradingWeek(asOfMs: number): RecapWeek {
  const b = brisbaneNow(asOfMs)
  const dow = b.getUTCDay() // 0 Sun..6 Sat (b is already Brisbane-shifted)
  // days back to the most recent Monday that starts a COMPLETED week:
  // on Mon we want last week's Mon (7 days back); generally go to this week's
  // Monday then step back 7.
  const thisMon = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() - ((dow + 6) % 7)))
  const lastMon = new Date(thisMon); lastMon.setUTCDate(thisMon.getUTCDate() - 7)
  const lastFri = new Date(lastMon); lastFri.setUTCDate(lastMon.getUTCDate() + 4)
  return { start: ymd(lastMon), end: ymd(lastFri) }
}

// Overnight-leads span for a report week/range (Brisbane): from 17:30 on the
// last trading day BEFORE the range (the night leading into its first
// morning) through 07:00 on the first trading day AFTER it, capped at `now`.
// For a Mon–Fri week that's Fri-before 5:30pm → Mon-after 7:00am, so the
// Monday 7am email of last week's recap carries the weekend just gone.
export function overnightLeadsSpan(week: RecapWeek, nowMs: number): { startMs: number; endMs: number } {
  const s = new Date(week.start + 'T00:00:00Z')
  do { s.setUTCDate(s.getUTCDate() - 1) } while (s.getUTCDay() === 0 || s.getUTCDay() === 6)
  const startMs = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate(), 17, 30) - AU_TZ_OFFSET_MS
  const e = new Date(week.end + 'T00:00:00Z')
  do { e.setUTCDate(e.getUTCDate() + 1) } while (e.getUTCDay() === 0 || e.getUTCDay() === 6)
  const endMs = Math.min(nowMs, Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate(), 7, 0) - AU_TZ_OFFSET_MS)
  return { startMs, endMs: Math.max(startMs, endMs) }
}

// Out-of-office-hours in Brisbane: weekends, or weekdays before 7:00am /
// from 5:30pm. This is the per-lead filter inside the span above.
export function isOutOfHours(ms: number): boolean {
  const b = brisbaneNow(ms)
  const dow = b.getUTCDay()
  if (dow === 0 || dow === 6) return true
  const mins = b.getUTCHours() * 60 + b.getUTCMinutes()
  return mins < 7 * 60 || mins >= 17 * 60 + 30
}

// The CURRENT trading week so far: this week's Monday → Friday (the full
// Mon–Fri window). Daily rows past `asOfMs` simply carry no data yet, so the
// live "This week" view fills in as the week progresses.
export function currentTradingWeek(asOfMs: number): RecapWeek {
  const b = brisbaneNow(asOfMs)
  const dow = b.getUTCDay()
  const thisMon = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() - ((dow + 6) % 7)))
  const fri = new Date(thisMon); fri.setUTCDate(thisMon.getUTCDate() + 4)
  return { start: ymd(thisMon), end: ymd(fri) }
}

function tradingDays(startYmd: string, endYmd: string): string[] {
  const out: string[] = []
  const s = new Date(startYmd + 'T00:00:00Z'); const e = new Date(endYmd + 'T00:00:00Z')
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay()
    if (dow >= 1 && dow <= 5) out.push(ymd(d)) // Mon–Fri
  }
  return out
}
const money = (n: number) => Math.round(n * 100) / 100
const monthLabel = (m: string) => {
  const [y, mo] = m.split('-')
  return new Date(Date.UTC(Number(y), Number(mo) - 1, 1)).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })
}

export interface AssembleInput {
  nowMs: number
  orders: OrderRow[]          // year-to-date
  dist: DistRow[]             // year-to-date
  diaryNotes: { content: string; start: string | null; end: string | null; officeOnly: boolean; workshopOnly: boolean }[]
  forecast: { month: string; value: number; jobCount: number }[]
  flags?: FlagOut[]           // LLM-supplied; falls back to rule-based
  week?: RecapWeek            // override the recap week (live "This week" view); defaults to the previous completed trading week
  quoteLeads?: QuoteLeadRow[] | null  // recent quote-channel leads (created_at based); omit → no overnight section
  negativeFeedback?: NegativeFeedbackOut | null  // pre-fetched negative-channel posts (lib/sales-recap-slack); omit → no section
}

export function assembleRecap(input: AssembleInput): SalesRecap {
  const week = input.week ?? previousTradingWeek(input.nowMs)
  const days = tradingDays(week.start, week.end)

  // Section 1 — daily breakdown for the recap week
  const daily = dailyBreakdown(input.orders, input.dist, days)
  const wt = windowTotals(input.orders, input.dist, week.start, week.end)
  const daysWithData = daily.filter(d => d.total > 0).length
  const weekTotal = {
    ...wt,
    tradingDaysWithData: daysWithData,
    dailyAvg: daysWithData ? money(wt.total / daysWithData) : 0,
  }

  // Section 2 — rolling comparison: recap week + previous 3 weeks
  const rolling: WeekComparisonRow[] = []
  for (let i = 0; i < 4; i++) {
    const s = new Date(week.start + 'T00:00:00Z'); s.setUTCDate(s.getUTCDate() - i * 7)
    const e = new Date(s); e.setUTCDate(s.getUTCDate() + 4)
    const w = windowTotals(input.orders, input.dist, ymd(s), ymd(e))
    const dwd = tradingDays(ymd(s), ymd(e)).filter(d => (windowTotals(input.orders, input.dist, d, d).total) > 0).length
    rolling.push({
      label: `${new Date(s).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })}–${new Date(e).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })}`,
      start: ymd(s), end: ymd(e), orders: w.orders, distributor: w.distributor, total: w.total,
      tradingDays: dwd, dailyAvg: dwd ? money(w.total / dwd) : 0,
    })
  }

  // Section 3 — monthly summary (year-to-date)
  const monthly = monthlyBreakdown(input.orders, input.dist)

  // Section 4 — diary notes
  const diaryNotes: DiaryNoteOut[] = input.diaryNotes.map(n => ({
    content: n.content, start: n.start, end: n.end,
    scope: n.officeOnly ? 'office' : n.workshopOnly ? 'workshop' : 'all',
  }))

  // Section 5 — forecast (future months only, labelled)
  const thisMonth = ymd(brisbaneNow(input.nowMs)).slice(0, 7)
  const forecast: ForecastMonthOut[] = input.forecast
    .filter(f => f.month >= thisMonth)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map(f => ({ month: f.month, label: monthLabel(f.month), value: money(f.value), jobCount: f.jobCount }))

  // Section 6 — flags (LLM if supplied, else rule-based fallback)
  const flags = input.flags?.length ? input.flags : ruleFlags(monthly, rolling, weekTotal)

  // Overnight quote-channel leads for the report week/range (only when a
  // lead pull was supplied): out-of-hours arrivals within the span from the
  // night into the range's first day to 7am after its last day.
  let overnight: OvernightOut | null = null
  if (input.quoteLeads) {
    const { startMs, endMs } = overnightLeadsSpan(week, input.nowMs)
    const fmt = (ms: number) => new Date(ms).toLocaleString('en-AU', {
      timeZone: 'Australia/Brisbane', weekday: 'short', day: '2-digit', month: 'short',
      hour: 'numeric', minute: '2-digit', hour12: true,
    })
    const leads = input.quoteLeads
      .filter(l => {
        const t = Date.parse(l.createdAt)
        return Number.isFinite(t) && t >= startMs && t < endMs && isOutOfHours(t)
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(l => ({ channel: l.channel, name: l.name, phone: l.phone, createdAt: l.createdAt }))
    overnight = {
      start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
      label: `${fmt(startMs)} → ${fmt(endMs)} · nights + weekends only`, leads,
    }
  }

  return {
    week, generatedAt: new Date(input.nowMs).toISOString(), dailyTarget: DAILY_TARGET,
    daily, weekTotal, rolling, monthly, diaryNotes, forecast, flags, overnight,
    negativeFeedback: input.negativeFeedback ?? null,
  }
}

// Span the negative-feedback pull covers: midnight Brisbane opening the
// report range through 7:00am on the first trading day after it (same tail
// as the overnight-leads span, so the Monday email includes weekend posts),
// capped at `now`.
export function negativeFeedbackSpan(week: RecapWeek, nowMs: number): { startMs: number; endMs: number } {
  const startMs = Date.parse(week.start + 'T00:00:00Z') - AU_TZ_OFFSET_MS
  const { endMs } = overnightLeadsSpan(week, nowMs)
  return { startMs, endMs: Math.max(startMs, endMs) }
}

// Deterministic fallback flags when no LLM output is provided.
function ruleFlags(monthly: MonthRow[], rolling: WeekComparisonRow[], weekTotal: SalesRecap['weekTotal']): FlagOut[] {
  const flags: FlagOut[] = []
  if (monthly.length >= 2) {
    const cur = monthly[monthly.length - 1]
    const prev = monthly[monthly.length - 2]
    if (prev.total > 0) {
      const pct = Math.round(((cur.total - prev.total) / prev.total) * 100)
      if (pct <= -20) flags.push({ priority: 'HIGH', item: `${monthLabel(cur.month)} tracking ${pct}% vs ${monthLabel(prev.month)} ($${cur.total.toLocaleString()} vs $${prev.total.toLocaleString()}).` })
    }
  }
  const belowTarget = rolling.filter(r => r.dailyAvg > 0 && r.dailyAvg < DAILY_TARGET).length
  if (belowTarget >= 2) flags.push({ priority: 'MED', item: `${belowTarget} of the last 4 weeks averaged below the $${DAILY_TARGET.toLocaleString()} daily target.` })
  if (weekTotal.dailyAvg >= DAILY_TARGET) flags.push({ priority: 'INFO', item: `Recap week averaged $${weekTotal.dailyAvg.toLocaleString()}/day — at or above target.` })
  if (!flags.length) flags.push({ priority: 'INFO', item: 'No target/trend flags this week.' })
  return flags
}
