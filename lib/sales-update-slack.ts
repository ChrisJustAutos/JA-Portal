// lib/sales-update-slack.ts
// SERVER-ONLY. The 5:15pm sales update posted to #sales-updates.
//
// Monday-to-Thursday it posts the day: Just Autos bookings, distributor value,
// the combined total against the daily target, and who wrote the most. Friday
// it posts the week instead, with a Mon-Fri breakdown so the shape of the week
// is visible (Chris, 2026-08-31).
//
// Every figure comes from lib/sales-figures-monday, the same source as
// Reports → Sales Report, so the Slack post and the report can never disagree.
// "Sales" here means ORDERS WRITTEN, not turnover invoiced — that is what the
// Monday boards hold and what the team is measured on.

import { fetchSalesFigures, type SalesFiguresData } from './sales-figures-monday'
import { getIntegration, getIntegrations } from './integration-config'
import { postMessage } from './slack-bot/slack'

/** Brisbane is UTC+10 all year (no DST), so shifting the clock is enough. */
function brisbane(now: Date = new Date()): Date {
  return new Date(now.getTime() + 10 * 3600_000)
}
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const money = (n: number) => '$' + Math.round(n).toLocaleString('en-AU')

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

function longDate(d: Date): string {
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

/** Monday of the Brisbane week `d` falls in. */
function mondayOf(d: Date): Date {
  const dow = d.getUTCDay()                    // 0 Sun .. 6 Sat
  const back = dow === 0 ? 6 : dow - 1         // Sunday belongs to the week just gone
  return new Date(d.getTime() - back * 86_400_000)
}

export type UpdateMode = 'daily' | 'weekly'

/** Per-day targets, one per stream (Chris, 2026-08-31: $60k JA + $50k dist). */
export interface DailyTargets { ja: number; dist: number; combined: number }

const TARGET_DEFAULTS = { ja: 60_000, dist: 50_000 }

export async function getSalesUpdateTargets(): Promise<DailyTargets> {
  const cfg = await getIntegrations(['SALES_TARGET_JA_PER_DAY', 'SALES_TARGET_DIST_PER_DAY'] as const)
  const n = (raw: string, fallback: number) => {
    const v = parseFloat(String(raw).replace(/[^0-9.-]/g, ''))
    return Number.isFinite(v) && v > 0 ? v : fallback
  }
  const ja = n(cfg.SALES_TARGET_JA_PER_DAY, TARGET_DEFAULTS.ja)
  const dist = n(cfg.SALES_TARGET_DIST_PER_DAY, TARGET_DEFAULTS.dist)
  return { ja, dist, combined: ja + dist }
}

export interface SalesUpdate {
  mode: UpdateMode
  since: string
  until: string
  text: string
  blocks: any[]
  /** Figures behind the message, so a preview can be checked without sending. */
  summary: {
    ordersValue: number; ordersCount: number
    distValue: number; distCount: number
    total: number; target: number; pctOfTarget: number
    targetJa: number; targetDist: number
    topSeller: { person: string; total: number } | null
  }
}

/**
 * Build the message. `mode` is chosen by the caller so a preview can force
 * either shape on any day.
 */
export async function buildSalesUpdate(mode: UpdateMode, now: Date = new Date()): Promise<SalesUpdate> {
  const token = process.env.MONDAY_API_TOKEN
  if (!token) throw new Error('MONDAY_API_TOKEN not set')

  const bris = brisbane(now)
  const today = ymd(bris)
  const since = mode === 'weekly' ? ymd(mondayOf(bris)) : today
  const until = today

  const [figures, targets] = await Promise.all([
    fetchSalesFigures(token, { since, until, now: bris }),
    getSalesUpdateTargets(),
  ])
  return renderSalesUpdate(figures, targets, mode, bris, since, until)
}

/**
 * Pure rendering — no network, no clock of its own. Split out from
 * buildSalesUpdate so the exact message can be checked against known figures
 * without Monday or Slack credentials, which is the only way to verify the
 * wording before it goes to a company-wide channel.
 */
export function renderSalesUpdate(
  figures: Pick<SalesFiguresData, 'totals' | 'people' | 'daily'>,
  perDay: DailyTargets,
  mode: UpdateMode,
  bris: Date,
  since: string,
  until: string,
): SalesUpdate {

  // Target: the whole-business daily figure (SALES_TARGET_PER_DAY, editable in
  // the portal's integration settings). The weekly target is that times the
  // number of weekdays covered so far, so a Friday post is measured against a
  // full week and a mid-week preview is not flattered by comparing five days
  // of target to two days of sales.
  const weekdaysCovered = mode === 'weekly' ? Math.max(1, countWeekdays(since, until)) : 1
  const targetJa = perDay.ja * weekdaysCovered
  const targetDist = perDay.dist * weekdaysCovered
  const target = targetJa + targetDist

  const t = figures.totals
  const pct = target > 0 ? Math.round((t.total / target) * 100) : 0
  const top = figures.people.find(p => p.total > 0) || null   // already sorted by total desc

  const summary = {
    ordersValue: t.ordersValue, ordersCount: t.ordersCount,
    distValue: t.distValue, distCount: t.distCount,
    total: t.total, target, pctOfTarget: pct,
    targetJa, targetDist,
    topSeller: top ? { person: top.person, total: top.total } : null,
  }

  const heading = mode === 'weekly'
    ? `:bar_chart: *Week in review* — ${longDate(new Date(since + 'T00:00:00Z'))} to ${longDate(new Date(until + 'T00:00:00Z'))}`
    : `:bar_chart: *Sales update* — ${longDate(bris)}`

  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  const pctJa = targetJa > 0 ? Math.round((t.ordersValue / targetJa) * 100) : 0
  const pctDist = targetDist > 0 ? Math.round((t.distValue / targetDist) * 100) : 0
  const lines = [
    `*Just Autos bookings*  ${money(t.ordersValue)}  _(${plural(t.ordersCount, 'order')})_  ·  ${pctJa}% of ${money(targetJa)} ${statusEmoji(pctJa)}`,
    `*Distributors*  ${money(t.distValue)}  _(${plural(t.distCount, 'order')})_  ·  ${pctDist}% of ${money(targetDist)} ${statusEmoji(pctDist)}`,
    `*Total*  ${money(t.total)}  —  ${pct}% of the ${money(target)} target ${statusEmoji(pct)}`,
  ]

  const topLine = top
    ? `:trophy: *Top seller ${mode === 'weekly' ? 'this week' : 'today'}:* ${top.person} — ${money(top.total)}`
    : '_No orders written yet._'

  const blocks: any[] = [
    { type: 'section', text: { type: 'mrkdwn', text: heading } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    { type: 'section', text: { type: 'mrkdwn', text: topLine } },
  ]

  // Friday only: how the week actually fell, so a good total built on one big
  // day reads differently from five steady ones.
  if (mode === 'weekly') {
    const rows = figures.daily
      .filter(d => d.date >= since && d.date <= until)
      .map(d => {
        const dt = new Date(d.date + 'T00:00:00Z')
        const name = DAY_NAMES[dt.getUTCDay()].slice(0, 3)
        const hit = d.total >= perDay.combined ? ' :white_check_mark:' : ''
        return `${name}   ${money(d.total)}${hit}`
      })
    if (rows.length) {
      blocks.push({ type: 'divider' })
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Day by day*\n' + rows.join('\n') } })
    }
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Orders written, from the Monday boards — the same figures as Reports → Sales Report. Targets are adjustable in the portal: Settings → Integrations → `SALES_TARGET_JA_PER_DAY` and `SALES_TARGET_DIST_PER_DAY`.' }],
  })

  // Slack's notification/preview line. Built explicitly rather than by
  // stripping markdown: a blanket /[*_]/ strip also eats the underscores
  // inside emoji shortcodes, turning :bar_chart: into :barchart:.
  const periodLabel = mode === 'weekly'
    ? `Week in review — ${longDate(new Date(since + 'T00:00:00Z'))} to ${longDate(new Date(until + 'T00:00:00Z'))}`
    : `Sales update — ${longDate(new Date(until + 'T00:00:00Z'))}`
  const text = [
    periodLabel,
    `Just Autos bookings ${money(t.ordersValue)} (${plural(t.ordersCount, 'order')}) - ${pctJa}% of ${money(targetJa)}`,
    `Distributors ${money(t.distValue)} (${plural(t.distCount, 'order')}) - ${pctDist}% of ${money(targetDist)}`,
    `Total ${money(t.total)} — ${pct}% of the ${money(target)} target`,
    top ? `Top seller: ${top.person} — ${money(top.total)}` : 'No orders written yet.',
  ].join('\n')
  return { mode, since, until, text, blocks, summary }
}

function statusEmoji(pct: number): string {
  if (pct >= 100) return ':white_check_mark:'
  if (pct >= 75) return ':large_yellow_circle:'
  return ':red_circle:'
}

/** Weekdays (Mon-Fri) inclusive between two YMD dates. */
function countWeekdays(sinceYmd: string, untilYmd: string): number {
  let n = 0
  const end = new Date(untilYmd + 'T00:00:00Z').getTime()
  for (let t = new Date(sinceYmd + 'T00:00:00Z').getTime(); t <= end; t += 86_400_000) {
    const dow = new Date(t).getUTCDay()
    if (dow >= 1 && dow <= 5) n++
  }
  return n
}

/** Channel is a portal setting so it can be moved without a deploy. */
export async function salesUpdateChannel(): Promise<string> {
  // #sales-updates (id from Chris, 2026-08-31). An id rather than a name so it
  // survives a channel rename; still overridable in the portal.
  return (await getIntegration('SALES_UPDATE_SLACK_CHANNEL')) || 'C0BTL0TND6X'
}

export async function postSalesUpdate(mode: UpdateMode, now: Date = new Date()): Promise<{
  posted: boolean; mode: UpdateMode; channel: string; reason?: string; summary: SalesUpdate['summary']
}> {
  const update = await buildSalesUpdate(mode, now)
  const channel = await salesUpdateChannel()
  const res = await postMessage({ channel, text: update.text, blocks: update.blocks })
  return {
    posted: !!res, mode, channel,
    reason: res ? undefined : 'Slack rejected the post — check the bot is in the channel and the id/name is right.',
    summary: update.summary,
  }
}
