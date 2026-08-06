// lib/mgmt-dashboard.ts
//
// Management Dashboard (JAWS) â€” assembles the full report payload for
// pages/api/reports/mgmt-dashboard from live MYOB data. Rebuild of the
// JAWS_Management_Dashboard Excel workbook (see migration 184 for the seeded
// chart configs and docs/spec provenance).
//
// Everything is computed FROM the mgmt_dashboard_charts config rows â€” account
// lists, exclusion rules, tuning-COS estimate, cash accounts, top-N â€” never
// hardcoded, so the report stays editable from the UI (PATCH on the API).
//
// Data sources (all JAWS company file):
//   - GL journal lines      lib/myob-gl fetchGlJournalLines   (revenue/COGS/expenses)
//   - Chart of accounts     lib/myob-gl fetchGlAccounts       (cash balances + tickbox list)
//   - Sale invoices         lib/myob-reporting fetchSaleInvoices (customer chart)
//   - Inventory items       lib/myob-reporting fetchInventoryItems (stock value)
// The four pulls are bundled and cached in mgmt_dashboard_cache; a <10-min-old
// bundle is served unless refresh is forced. On a failed refresh we fall back
// to the stale bundle rather than 500ing the dashboard.
//
// Exception: the revenueOrdersLeads chart (migration 189) reads the VPS
// company file + Monday quote-channel boards instead â€” it runs its own pull
// with its own mgmt_dashboard_cache row (6-hour TTL; monthly backfill barely
// moves) and skips itself on failure rather than sinking the dashboard.
//
// GL sign convention (see lib/myob-gl): line amounts are debit-positive, so
//   revenue  = Î£(âˆ’amount) over 4-* scope   (the workbook's Hâˆ’G)
//   COGS/opex= Î£(+amount) over 5-*/6-*     (the workbook's Gâˆ’H)

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchGlJournalLines, fetchGlAccounts, GlLine, GlAccount } from './myob-gl'
import { fetchSaleInvoices, fetchInventoryItems, SaleInvoiceRow } from './myob-reporting'
import { fetchMonthlyLeadCounts, fetchOrders } from './sales-recap-monday'

const LABEL = 'JAWS' as const
const CACHE_KEY = 'source:JAWS'
const CACHE_TTL_MS = 10 * 60 * 1000

// â”€â”€ Payload contract (the frontend is built against exactly this) â”€â”€â”€â”€â”€â”€â”€

export interface MgmtKpi {
  key: string
  label: string
  value: number | string
  format: 'currency' | 'number' | 'days' | 'ratio' | 'text'
  sub?: string
}
export interface MgmtChartPoint { label: string; value: number }
export interface MgmtChartSeries { name: string; points: MgmtChartPoint[] }
// Per-series render hints (dual-axis charts): which y-axis the series is
// scaled against and how its values format. Series without an entry default
// to the left axis / the chart-level valueFormat.
export interface MgmtChartSeriesOption {
  name: string
  axis?: 'left' | 'right'
  valueFormat?: 'currency' | 'number'
}
export interface MgmtChart {
  key: string
  title: string
  type: 'bars' | 'stackedBars' | 'pie' | 'hbar'
  series: MgmtChartSeries[]
  options?: {
    stacked?: boolean
    valueFormat?: 'currency' | 'number'
    dualAxis?: boolean
    series?: MgmtChartSeriesOption[]
  }
}
export interface MgmtChartConfigRow {
  key: string
  title: string
  enabled: boolean
  chart_type: string
  position: number
  config: any
}
export interface MgmtAccountRow {
  code: string
  name: string
  kind: 'income' | 'cogs' | 'asset' | 'other'
}
export interface MgmtDashboardPayload {
  generatedAt: string
  kpis: MgmtKpi[]
  charts: MgmtChart[]
  config: { charts: MgmtChartConfigRow[]; accounts: MgmtAccountRow[] }
}

// â”€â”€ Config shapes (stored in mgmt_dashboard_charts.config) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface ScopeCfg { prefix?: string; exclude?: string[] }
interface ExclCfg { invoiceNumberPattern?: string; memoPattern?: string }
interface CategoryCfg { name: string; accounts?: string[]; rest?: boolean }

// â”€â”€ Date helpers (UTC math on YYYY-MM-DD strings; Brisbane "today") â”€â”€â”€â”€â”€

function ymdToDate(ymd: string): Date { return new Date(ymd + 'T00:00:00Z') }
function dateToYmd(d: Date): string { return d.toISOString().slice(0, 10) }
function addDays(ymd: string, n: number): string {
  const d = ymdToDate(ymd); d.setUTCDate(d.getUTCDate() + n); return dateToYmd(d)
}
function todayBrisbane(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' })
}
function mondayOf(ymd: string): string {
  const dow = ymdToDate(ymd).getUTCDay() // 0=Sun
  return addDays(ymd, -((dow + 6) % 7))
}
function firstOfMonth(ymd: string): string { return ymd.slice(0, 8) + '01' }
function addMonths(ymd: string, n: number): string {
  const d = ymdToDate(ymd); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); return dateToYmd(d)
}
function daysInMonthOf(ymd: string): number {
  const d = ymdToDate(ymd)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
}
function fmtDayMonth(ymd: string): string {
  return ymdToDate(ymd).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}
function weekLabel(start: string, end: string): string {
  return `${fmtDayMonth(start)} â€“ ${fmtDayMonth(end)}`
}

interface Window { start: string; end: string } // inclusive both ends

// â”€â”€ Scope / exclusion helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const round2 = (n: number) => Math.round(n * 100) / 100

function scopeMatcher(scope?: ScopeCfg): (code: string) => boolean {
  const prefix = scope?.prefix || ''
  const excl = new Set(scope?.exclude || [])
  return (code: string) => (!prefix || code.indexOf(prefix) === 0) && !excl.has(code)
}
function accountsMatcher(codes?: string[]): (code: string) => boolean {
  const set = new Set(codes || [])
  return (code: string) => set.has(code)
}
// B2B intercompany rule: journal "ID No." contains the pattern (JAWSB2B####),
// or the memo matches the stock-transfer memo pattern.
function makeExcluder(excl?: ExclCfg): (r: GlLine) => boolean {
  let idRe: RegExp | null = null
  let memoRe: RegExp | null = null
  try { if (excl?.invoiceNumberPattern) idRe = new RegExp(excl.invoiceNumberPattern, 'i') } catch { /* bad config regex â†’ ignore */ }
  try { if (excl?.memoPattern) memoRe = new RegExp(excl.memoPattern, 'i') } catch { /* ignore */ }
  return (r: GlLine) =>
    (!!idRe && !!r.invoiceNumberish && idRe.test(r.invoiceNumberish)) ||
    (!!memoRe && !!r.memo && memoRe.test(r.memo))
}

// Î£ over GL lines in a window. credit=true sums credit-positive (revenue),
// credit=false sums debit-positive (COGS/expenses).
function glSum(
  rows: GlLine[], w: Window,
  opts: { credit: boolean; match: (code: string) => boolean; excluded?: (r: GlLine) => boolean },
): number {
  let t = 0
  for (const r of rows) {
    if (r.dateIso < w.start || r.dateIso > w.end) continue
    if (!opts.match(r.accountDisplayId)) continue
    if (opts.excluded && opts.excluded(r)) continue
    t += opts.credit ? -r.amount : r.amount
  }
  return t
}

// â”€â”€ Window context â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The workbook's MAX(GL!N) idiom = "latest transaction date": every window is
// anchored on the newest GL row, so a file that hasn't been posted to for a
// few days still shows its own latest complete picture.

interface Ctx {
  latest: string
  currentWeek: Window     // Monâ€“Sun bucket containing `latest`
  prevWeek: Window
  mtd: Window             // 1st of latest's month â€¦ latest
  elapsedDays: number     // day-of-month of latest
  daysInMonth: number
}

function buildCtx(latest: string): Ctx {
  const monday = mondayOf(latest)
  const currentWeek = { start: monday, end: addDays(monday, 6) }
  const prevWeek = { start: addDays(monday, -7), end: addDays(monday, -1) }
  const mtd = { start: firstOfMonth(latest), end: latest }
  return {
    latest, currentWeek, prevWeek, mtd,
    elapsedDays: ymdToDate(latest).getUTCDate(),
    daysInMonth: daysInMonthOf(latest),
  }
}

function buildWeeks(latest: string, n: number): Array<Window & { label: string }> {
  const monday = mondayOf(latest)
  const out: Array<Window & { label: string }> = []
  for (let i = n - 1; i >= 0; i--) {
    const start = addDays(monday, -7 * i)
    const end = addDays(start, 6)
    out.push({ start, end, label: weekLabel(start, end) })
  }
  return out
}

function resolveWindow(w: any, ctx: Ctx): (Window & { name: string }) | null {
  const kind = w?.kind
  if (kind === 'currentWeek') return { ...ctx.currentWeek, name: w.name || 'Current 7 Days' }
  if (kind === 'mtd') return { ...ctx.mtd, name: w.name || 'MTD' }
  if (kind === 'trailing7') return { start: addDays(ctx.latest, -6), end: ctx.latest, name: w.name || 'Last 7 Days' }
  if (kind === 'fixed' && w.start && w.end) return { start: w.start, end: w.end, name: w.name || `${w.start} â€“ ${w.end}` }
  return null
}

// â”€â”€ Cached source bundle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface SourceBundle {
  pulledAt: string
  start: string
  endExclusive: string
  gl: GlLine[]
  invoices: SaleInvoiceRow[]
  items: any[]        // fetchInventoryItems shape (Number/Name/QuantityOnHand/CurrentValueâ€¦)
  accounts: GlAccount[]
}

async function loadSource(
  db: SupabaseClient, start: string, endExclusive: string, refresh: boolean,
): Promise<{ bundle: SourceBundle; fromCache: boolean }> {
  const { data: cachedRow } = await db
    .from('mgmt_dashboard_cache')
    .select('payload, refreshed_at')
    .eq('key', CACHE_KEY)
    .maybeSingle()
  const cached = (cachedRow?.payload || null) as SourceBundle | null
  const covers = !!cached && cached.start <= start && cached.endExclusive >= endExclusive
  const fresh = !!cachedRow?.refreshed_at &&
    Date.now() - new Date(cachedRow.refreshed_at).getTime() < CACHE_TTL_MS

  if (!refresh && cached && covers && fresh) return { bundle: cached, fromCache: true }

  try {
    // Sequential, not Promise.all â€” MYOB access-token refresh rotates the
    // refresh token, so parallel first-calls on a stale token can race.
    const gl = await fetchGlJournalLines(LABEL, { start, endExclusive })
    const invoices = await fetchSaleInvoices(LABEL, { start, endExclusive })
    const items = await fetchInventoryItems(LABEL)
    const accounts = await fetchGlAccounts(LABEL)
    const bundle: SourceBundle = { pulledAt: new Date().toISOString(), start, endExclusive, gl, invoices, items, accounts }
    await db.from('mgmt_dashboard_cache').upsert({
      key: CACHE_KEY, payload: bundle as any, refreshed_at: new Date().toISOString(),
    })
    return { bundle, fromCache: false }
  } catch (e) {
    if (cached && covers) {
      console.warn('[mgmt-dashboard] MYOB pull failed, serving stale cache:', (e as any)?.message || e)
      return { bundle: cached, fromCache: true }
    }
    throw e
  }
}

// â”€â”€ Category engine (charts 2 & 3) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Classify each in-scope GL revenue line by its income account: explicit
// account lists win; the single `rest:true` category absorbs the remainder
// (this replaces the workbook's dominant-invoice-line categorisation and its
// "Other" reconciliation plug).

function categoryTotals(
  gl: GlLine[], w: Window, categories: CategoryCfg[],
  revScope: (code: string) => boolean, excluded: (r: GlLine) => boolean,
): Record<string, number> {
  const byAccount: Record<string, string> = {}
  let restName: string | null = null
  const totals: Record<string, number> = {}
  for (const c of categories) {
    totals[c.name] = 0
    if (c.rest) restName = c.name
    for (const a of c.accounts || []) byAccount[a] = c.name
  }
  for (const r of gl) {
    if (r.dateIso < w.start || r.dateIso > w.end) continue
    if (!revScope(r.accountDisplayId)) continue
    if (excluded(r)) continue
    const cat = byAccount[r.accountDisplayId] || restName
    if (cat) totals[cat] += -r.amount
  }
  return totals
}

// â”€â”€ Chart builders (dispatch on config.kind) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const CHART_TYPES: Array<MgmtChart['type']> = ['bars', 'stackedBars', 'pie', 'hbar']
function chartType(row: MgmtChartConfigRow, fallback: MgmtChart['type']): MgmtChart['type'] {
  return CHART_TYPES.indexOf(row.chart_type as any) >= 0 ? row.chart_type as MgmtChart['type'] : fallback
}

// Chart 1 â€” weekly Revenue + Gross Profit columns.
// GP(w) = REV(w) âˆ’ COGS(w) âˆ’ tuningCosPct Ã— TUNING_REV(w)  (booked 5-* COGS
// carries no tuning cost, so it's estimated off tuning revenue).
function buildWeeklyRevenueGp(row: MgmtChartConfigRow, ctx: Ctx, src: SourceBundle): MgmtChart {
  const cfg = row.config || {}
  const rev = scopeMatcher(cfg.revenueScope)
  const cogs = scopeMatcher(cfg.cogsScope)
  const tuning = accountsMatcher(cfg.tuningAccounts)
  const excluded = makeExcluder(cfg.exclusions)
  const cosPct = Number(cfg.tuningCosPct) || 0
  const weeks = buildWeeks(ctx.latest, Number(cfg.weeks) || 5)

  const revPts: MgmtChartPoint[] = []
  const gpPts: MgmtChartPoint[] = []
  for (const w of weeks) {
    const r = glSum(src.gl, w, { credit: true, match: rev, excluded })
    const c = glSum(src.gl, w, { credit: false, match: cogs, excluded })
    const t = glSum(src.gl, w, { credit: true, match: tuning, excluded })
    revPts.push({ label: w.label, value: round2(r) })
    gpPts.push({ label: w.label, value: round2(r - c - cosPct * t) })
  }
  return {
    key: row.key, title: row.title, type: chartType(row, 'bars'),
    series: [{ name: 'Revenue', points: revPts }, { name: 'Gross Profit', points: gpPts }],
    options: { valueFormat: cfg.valueFormat === 'number' ? 'number' : 'currency' },
  }
}

// Chart 2 â€” category revenue for N windows (one series per window).
function buildCategoryCompare(row: MgmtChartConfigRow, ctx: Ctx, src: SourceBundle): MgmtChart | null {
  const cfg = row.config || {}
  const categories: CategoryCfg[] = Array.isArray(cfg.categories) ? cfg.categories : []
  if (!categories.length) return null
  const rev = scopeMatcher(cfg.revenueScope)
  const excluded = makeExcluder(cfg.exclusions)
  const series: MgmtChartSeries[] = []
  for (const wCfg of Array.isArray(cfg.windows) ? cfg.windows : []) {
    const w = resolveWindow(wCfg, ctx)
    if (!w) continue
    const totals = categoryTotals(src.gl, w, categories, rev, excluded)
    series.push({
      name: w.name,
      points: categories.map(c => ({ label: c.name, value: round2(totals[c.name] || 0) })),
    })
  }
  if (!series.length) return null
  return {
    key: row.key, title: row.title, type: chartType(row, 'bars'),
    series, options: { valueFormat: 'currency' },
  }
}

// Chart 3 â€” stacked weekly category mix (one series per category).
function buildWeeklyCategoryStack(row: MgmtChartConfigRow, ctx: Ctx, src: SourceBundle): MgmtChart | null {
  const cfg = row.config || {}
  const categories: CategoryCfg[] = Array.isArray(cfg.categories) ? cfg.categories : []
  if (!categories.length) return null
  const rev = scopeMatcher(cfg.revenueScope)
  const excluded = makeExcluder(cfg.exclusions)
  const weeks = buildWeeks(ctx.latest, Number(cfg.weeks) || 5)
  const perWeek = weeks.map(w => categoryTotals(src.gl, w, categories, rev, excluded))
  return {
    key: row.key, title: row.title, type: chartType(row, 'stackedBars'),
    series: categories.map(c => ({
      name: c.name,
      points: weeks.map((w, i) => ({ label: w.label, value: round2(perWeek[i][c.name] || 0) })),
    })),
    options: { stacked: true, valueFormat: 'currency' },
  }
}

// Chart 4 â€” top-N inventory items by on-hand value (items pre-sorted desc by
// CurrentValue in fetchInventoryItems).
function buildTopInventory(row: MgmtChartConfigRow, _ctx: Ctx, src: SourceBundle): MgmtChart {
  const cfg = row.config || {}
  const topN = Number(cfg.topN) || 10
  const points = src.items
    .filter(it => (Number(it.CurrentValue) || 0) > 0)
    .slice(0, topN)
    .map(it => ({ label: String(it.Name || it.Number || '?'), value: round2(Number(it.CurrentValue) || 0) }))
  return {
    key: row.key, title: row.title, type: chartType(row, 'bars'),
    series: [{ name: 'Value', points }],
    options: { valueFormat: 'currency' },
  }
}

// Chart 5 â€” trailing-7-day revenue pie per part-type income account, with
// "Other Parts" = parts revenue (scope âˆ’ tuning âˆ’ oil) âˆ’ Î£ all named
// part-type accounts, floored at 0.
function buildAccountPie(row: MgmtChartConfigRow, ctx: Ctx, src: SourceBundle): MgmtChart {
  const cfg = row.config || {}
  const days = Number(cfg.windowDays) || 7
  const w: Window = { start: addDays(ctx.latest, -(days - 1)), end: ctx.latest }
  const rev = scopeMatcher(cfg.revenueScope)
  const excluded = makeExcluder(cfg.exclusions)

  const points: MgmtChartPoint[] = []
  for (const s of Array.isArray(cfg.slices) ? cfg.slices : []) {
    const v = glSum(src.gl, w, { credit: true, match: accountsMatcher(s.accounts), excluded })
    points.push({ label: String(s.label || (s.accounts || []).join('+')), value: round2(v) })
  }

  if (cfg.otherLabel) {
    const partType: Record<string, string> = cfg.partTypeAccounts || {}
    const namedCodes: string[] = Object.keys(partType).map(k => partType[k])
    const total = glSum(src.gl, w, { credit: true, match: rev, excluded })
    const tuning = glSum(src.gl, w, { credit: true, match: accountsMatcher(cfg.partsExclude?.tuningAccounts), excluded })
    const oil = glSum(src.gl, w, { credit: true, match: accountsMatcher(cfg.partsExclude?.oilAccounts), excluded })
    const named = glSum(src.gl, w, { credit: true, match: accountsMatcher(namedCodes), excluded })
    points.push({ label: String(cfg.otherLabel), value: round2(Math.max(0, total - tuning - oil - named)) })
  }

  return {
    key: row.key, title: row.title, type: chartType(row, 'pie'),
    series: [{ name: 'Revenue', points }],
    options: { valueFormat: 'currency' },
  }
}

// Chart 6 â€” top-N customers by ex-GST invoice revenue for the window.
// Grouping fixes baked into config: alias merge (name variants of the same
// shop), optional " (Tuning)" card merge, VPS intercompany + Stripe
// adjustment cards excluded, B2B invoice numbers excluded.
function buildTopCustomers(row: MgmtChartConfigRow, ctx: Ctx, src: SourceBundle): MgmtChart {
  const cfg = row.config || {}
  const w = resolveWindow(cfg.window, ctx) || { ...ctx.mtd, name: 'MTD' }
  let numRe: RegExp | null = null
  try { if (cfg.exclusions?.invoiceNumberPattern) numRe = new RegExp(cfg.exclusions.invoiceNumberPattern, 'i') } catch { /* ignore */ }
  const alias: Record<string, string> = cfg.aliasMerge || {}
  const excludeExact = new Set<string>((cfg.excludeCustomers || []).map((n: string) => n.toLowerCase()))
  const excludePatterns: RegExp[] = []
  for (const p of Array.isArray(cfg.excludeCustomerPatterns) ? cfg.excludeCustomerPatterns : []) {
    try { excludePatterns.push(new RegExp(p, 'i')) } catch { /* ignore */ }
  }

  const totals: Record<string, number> = {}
  for (const inv of src.invoices) {
    const d = (inv.Date || '').slice(0, 10)
    if (!d || d < w.start || d > w.end) continue
    if (numRe && inv.Number && numRe.test(inv.Number)) continue
    let name = (inv.CustomerName || '').trim()
    if (!name) continue
    if (alias[name]) name = alias[name]
    if (cfg.mergeTuningVariants) name = name.replace(/\s*\(Tuning\)\s*$/i, '')
    if (excludeExact.has(name.toLowerCase())) continue
    if (excludePatterns.some(re => re.test(name))) continue
    const value = cfg.basis === 'incGst' ? inv.TotalAmount : inv.TotalAmount - inv.TotalTax
    totals[name] = (totals[name] || 0) + value
  }
  const points = Object.keys(totals)
    .map(name => ({ label: name, value: round2(totals[name]) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, Number(cfg.topN) || 10)

  return {
    key: row.key, title: row.title, type: chartType(row, 'hbar'),
    series: [{ name: 'Revenue', points }],
    options: { valueFormat: 'currency' },
  }
}

// Chart 7 â€” Revenue vs Bookings vs Leads, monthly since config.startIso.
//   Revenue  = sale invoices (all types; credit notes are negative-total
//              invoices so they subtract naturally), ex-GST by default
//              (TotalAmount âˆ’ TotalTax), bucketed by invoice Date month.
//   Bookings = COUNT of Sale Orders (Sale/Order/* across all types) created
//              per month. NOTE: AccountRight removes an order once it is
//              converted to an invoice, so past months only show orders that
//              are still open orders today.
//   Leads    = inbound quote-channel leads per month from Monday (same
//              boards + intake-creator filter as the Sales Report, minus its
//              "Quote - Lead" group filter which decays for history).
// Backfill months don't change, so the pull gets its own cache row with a
// 6-hour TTL (vs the 10-min main bundle).

const ROL_CACHE_TTL_MS = 6 * 60 * 60 * 1000

interface RolBundle {
  pulledAt: string
  entity: 'VPS' | 'JAWS'
  startIso: string
  endExclusive: string
  revenueExByMonth: Record<string, number>   // YYYY-MM â†’ ex-GST $
  revenueIncByMonth: Record<string, number>  // YYYY-MM â†’ inc-GST $ (basis flip without re-pull)
  ordersByMonth: Record<string, number>      // YYYY-MM â†’ count
  leadsByMonth: Record<string, number>       // YYYY-MM â†’ count
}

function rolEntity(cfg: any): 'VPS' | 'JAWS' {
  return cfg?.entity === 'JAWS' ? 'JAWS' : 'VPS'
}
function rolStartIso(cfg: any): string {
  return typeof cfg?.startIso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cfg.startIso)
    ? cfg.startIso : '2025-01-01'
}

async function loadRolSource(db: SupabaseClient, cfg: any, refresh: boolean): Promise<RolBundle> {
  const entity = rolEntity(cfg)
  const startIso = rolStartIso(cfg)
  const endExclusive = addDays(todayBrisbane(), 1)
  const cacheKey = `revOrdersLeads:${entity}:${startIso}`

  const { data: cachedRow } = await db
    .from('mgmt_dashboard_cache')
    .select('payload, refreshed_at')
    .eq('key', cacheKey)
    .maybeSingle()
  const cached = (cachedRow?.payload || null) as RolBundle | null
  const covers = !!cached && cached.startIso <= startIso && cached.endExclusive >= endExclusive
  const fresh = !!cachedRow?.refreshed_at &&
    Date.now() - new Date(cachedRow.refreshed_at).getTime() < ROL_CACHE_TTL_MS
  if (!refresh && cached && covers && fresh) return cached

  try {
    // Sequential MYOB calls (same token-refresh race note as loadSource).
    const invoices = await fetchSaleInvoices(entity, { start: startIso, endExclusive })
    const token = process.env.MONDAY_API_TOKEN
    if (!token) throw new Error('MONDAY_API_TOKEN not set â€” required for the Bookings + Leads series')
    const leadsByMonth = await fetchMonthlyLeadCounts(token, startIso)
    // Bookings = the MONDAY Orders board (Chris 2026-08-06: "it's not MYOB
    // sale orders, it's Monday's") â€” same board + dead-status exclusions as
    // the weekly Sales Report, so the numbers reconcile. Full history, unlike
    // MYOB orders (deleted on conversion).
    const mondayOrders = await fetchOrders(token, startIso, endExclusive)

    const revenueExByMonth: Record<string, number> = {}
    const revenueIncByMonth: Record<string, number> = {}
    for (const inv of invoices) {
      const m = (inv.Date || '').slice(0, 7)
      if (!m) continue
      revenueIncByMonth[m] = (revenueIncByMonth[m] || 0) + inv.TotalAmount
      revenueExByMonth[m] = (revenueExByMonth[m] || 0) + (inv.TotalAmount - inv.TotalTax)
    }
    const ordersByMonth: Record<string, number> = {}
    for (const o of mondayOrders) {
      const m = String(o.date || '').slice(0, 7)
      if (m) ordersByMonth[m] = (ordersByMonth[m] || 0) + 1
    }

    const bundle: RolBundle = {
      pulledAt: new Date().toISOString(), entity, startIso, endExclusive,
      revenueExByMonth, revenueIncByMonth, ordersByMonth, leadsByMonth,
    }
    await db.from('mgmt_dashboard_cache').upsert({
      key: cacheKey, payload: bundle as any, refreshed_at: new Date().toISOString(),
    })
    return bundle
  } catch (e) {
    if (cached && covers) {
      console.warn('[mgmt-dashboard] rev/orders/leads pull failed, serving stale cache:', (e as any)?.message || e)
      return cached
    }
    throw e
  }
}

async function buildRevenueOrdersLeads(db: SupabaseClient, row: MgmtChartConfigRow, refresh: boolean): Promise<MgmtChart | null> {
  const cfg = row.config || {}
  let src: RolBundle
  try {
    src = await loadRolSource(db, cfg, refresh)
  } catch (e) {
    // A Monday/MYOB outage on this side-pull shouldn't sink the rest of the
    // dashboard â€” skip the chart (same spirit as unknown-kind â†’ skip).
    console.error('[mgmt-dashboard] revenueOrdersLeads failed:', (e as any)?.message || e)
    return null
  }

  // Month buckets from startIso's month through the current Brisbane month.
  const endMonth = todayBrisbane().slice(0, 7)
  const months: string[] = []
  for (let d = firstOfMonth(src.startIso); d.slice(0, 7) <= endMonth && months.length < 240; d = addMonths(d, 1)) {
    months.push(d.slice(0, 7))
  }
  const monthLabel = (m: string) =>
    `${ymdToDate(m + '-01').toLocaleDateString('en-AU', { month: 'short', timeZone: 'UTC' })} ${m.slice(2, 4)}`

  const revenue = cfg.revenueBasis === 'incGst' ? src.revenueIncByMonth : src.revenueExByMonth
  const pts = (byMonth: Record<string, number>, round = false): MgmtChartPoint[] =>
    months.map(m => ({ label: monthLabel(m), value: round ? round2(byMonth[m] || 0) : (byMonth[m] || 0) }))

  return {
    key: row.key, title: row.title, type: chartType(row, 'bars'),
    series: [
      { name: 'Revenue', points: pts(revenue, true) },
      { name: 'Bookings', points: pts(src.ordersByMonth) },
      { name: 'Leads', points: pts(src.leadsByMonth) },
    ],
    options: {
      valueFormat: 'currency',
      dualAxis: true,
      series: [
        { name: 'Revenue', axis: 'left', valueFormat: 'currency' },
        { name: 'Bookings', axis: 'right', valueFormat: 'number' },
        { name: 'Leads', axis: 'right', valueFormat: 'number' },
      ],
    },
  }
}

function buildChart(row: MgmtChartConfigRow, ctx: Ctx, src: SourceBundle): MgmtChart | null {
  switch (row.config?.kind) {
    case 'weeklyRevenueGp':    return buildWeeklyRevenueGp(row, ctx, src)
    case 'categoryCompare':    return buildCategoryCompare(row, ctx, src)
    case 'weeklyCategoryStack':return buildWeeklyCategoryStack(row, ctx, src)
    case 'topInventory':       return buildTopInventory(row, ctx, src)
    case 'accountPie':         return buildAccountPie(row, ctx, src)
    case 'topCustomers':       return buildTopCustomers(row, ctx, src)
    default:                   return null // unknown kind â†’ skip, don't 500
  }
}

// â”€â”€ KPI cards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const fmtMoney = (n: number) =>
  n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 })
const fmtPct = (x: number) => `${(x * 100).toFixed(1)}%`
const dirPct = (x: number) => `${x >= 0 ? 'up' : 'down'} ${fmtPct(Math.abs(x))}`

function buildKpis(cfg: any, ctx: Ctx, src: SourceBundle): MgmtKpi[] {
  const rev = scopeMatcher(cfg.revenueScope)
  const cogs = scopeMatcher(cfg.cogsScope)
  const tuning = accountsMatcher(cfg.tuningAccounts)
  const expense = scopeMatcher({ prefix: cfg.expensePrefix || '6-' })
  const excluded = makeExcluder(cfg.exclusions)
  const cosPct = Number(cfg.tuningCosPct) || 0
  const noExclusion = (_r: GlLine) => false

  const gpOf = (w: Window): { rev: number; gp: number } => {
    const r = glSum(src.gl, w, { credit: true, match: rev, excluded })
    const c = glSum(src.gl, w, { credit: false, match: cogs, excluded })
    const t = glSum(src.gl, w, { credit: true, match: tuning, excluded })
    return { rev: r, gp: r - c - cosPct * t }
  }

  // Current week vs prior week.
  const cur = gpOf(ctx.currentWeek)
  const prev = gpOf(ctx.prevWeek)
  const wow = prev.rev !== 0 ? (cur.rev - prev.rev) / prev.rev : null
  const gpWow = prev.gp !== 0 ? (cur.gp - prev.gp) / prev.gp : null
  const weekGm = cur.rev !== 0 ? cur.gp / cur.rev : 0

  // Cash in bank = live balances of the configured cash/bank accounts.
  const cashCodes = new Set<string>(cfg.cashAccounts || [])
  let cash = 0
  for (const a of src.accounts) if (cashCodes.has(a.code)) cash += a.currentBalance

  // Inventory.
  let inventoryValue = 0, skus = 0
  for (const it of src.items) {
    inventoryValue += Number(it.CurrentValue) || 0
    if ((Number(it.QuantityOnHand) || 0) > 0) skus++
  }
  // Stock-to-weekly-sales: denominator INCLUDES intercompany transfers-out
  // (workbook N12 adds the B2B-excluded amount back in) â€” so no exclusion.
  const weekRevInclB2b = glSum(src.gl, ctx.currentWeek, { credit: true, match: rev, excluded: noExclusion })
  const stockRatio = weekRevInclB2b !== 0 ? inventoryValue / weekRevInclB2b : 0

  // MTD + projection.
  const mtd = gpOf(ctx.mtd)
  const mtdGm = mtd.rev !== 0 ? mtd.gp / mtd.rev : 0
  const mtdCogs = mtd.rev - mtd.gp // booked COGS + estimated tuning COS (workbook B19)
  const mtdDailyAvg = ctx.elapsedDays > 0 ? mtd.rev / ctx.elapsedDays : 0
  const projectedMonth = mtdDailyAvg * ctx.daysInMonth
  const projectedGp = mtdGm * projectedMonth

  // Prior month, same number of elapsed days.
  const priorFirst = addMonths(ctx.latest, -1)
  const priorEndOfMonth = addDays(firstOfMonth(ctx.latest), -1)
  const priorSameDayEnd = addDays(priorFirst, ctx.elapsedDays - 1)
  const priorWindow: Window = { start: priorFirst, end: priorSameDayEnd < priorEndOfMonth ? priorSameDayEnd : priorEndOfMonth }
  const priorRev = glSum(src.gl, priorWindow, { credit: true, match: rev, excluded })
  const mtdChange = priorRev !== 0 ? (mtd.rev - priorRev) / priorRev : null

  // Days cash on hand = cash Ã· (MTD 6-* expenses Ã· elapsed days).
  const expensesMtd = glSum(src.gl, ctx.mtd, { credit: false, match: expense, excluded })
  const dailyExpense = ctx.elapsedDays > 0 ? expensesMtd / ctx.elapsedDays : 0
  const daysCash = dailyExpense > 0 ? cash / dailyExpense : 0

  // Headline sentence from the config template.
  const vars: Record<string, string> = {
    wow: wow != null ? dirPct(wow) : 'flat',
    gpWow: gpWow != null ? dirPct(gpWow) : 'flat',
    weekRevenue: fmtMoney(cur.rev),
    weekGp: fmtMoney(cur.gp),
    weekGm: fmtPct(weekGm),
    cash: fmtMoney(cash),
    inventory: fmtMoney(inventoryValue),
    stockRatio: (Math.round(stockRatio * 10) / 10).toFixed(1),
    mtdRevenue: fmtMoney(mtd.rev),
    mtdGm: fmtPct(mtdGm),
    projectedMonth: fmtMoney(projectedMonth),
    daysCash: String(Math.round(daysCash)),
  }
  const template: string = cfg.headlineTemplate ||
    'Revenue {wow} WoW to {weekRevenue}; GP {gpWow} at {weekGm} margin. Cash {cash}; inventory {inventory} ({stockRatio}x weekly sales). Month tracking to {projectedMonth} at {mtdGm} GM.'
  const headline = template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m))

  return [
    { key: 'headline', label: 'This week', value: headline, format: 'text' },
    { key: 'week_revenue', label: 'Revenue (current 7 days)', value: round2(cur.rev), format: 'currency', sub: wow != null ? `${dirPct(wow)} WoW` : undefined },
    { key: 'week_gp', label: 'Gross profit (current 7 days)', value: round2(cur.gp), format: 'currency', sub: gpWow != null ? `${dirPct(gpWow)} WoW` : undefined },
    { key: 'week_gm', label: 'Gross margin (current 7 days)', value: Math.round(weekGm * 10000) / 10000, format: 'ratio', sub: `avg ${fmtMoney(cur.rev / 7)}/day` },
    { key: 'cash_on_hand', label: 'Cash in bank', value: round2(cash), format: 'currency', sub: `${(cfg.cashAccounts || []).length} accounts` },
    { key: 'days_cash', label: 'Days cash on hand', value: Math.round(daysCash * 10) / 10, format: 'days', sub: dailyExpense > 0 ? `opex ${fmtMoney(dailyExpense)}/day MTD` : 'no MTD expenses recorded' },
    { key: 'inventory_value', label: 'Inventory value', value: round2(inventoryValue), format: 'currency', sub: `${skus} SKUs on hand` },
    { key: 'stock_to_weekly_sales', label: 'Stock : weekly sales', value: Math.round(stockRatio * 10) / 10, format: 'ratio', sub: 'incl. intercompany transfers-out' },
    { key: 'mtd_revenue', label: 'Revenue MTD', value: round2(mtd.rev), format: 'currency', sub: mtdChange != null ? `${dirPct(mtdChange)} vs same time last month (${fmtMoney(priorRev)})` : undefined },
    { key: 'mtd_gp', label: 'Gross profit MTD', value: round2(mtd.gp), format: 'currency', sub: `GM ${fmtPct(mtdGm)}` },
    { key: 'mtd_gm', label: 'Gross margin MTD', value: Math.round(mtdGm * 10000) / 10000, format: 'ratio' },
    { key: 'mtd_cogs', label: 'COGS MTD', value: round2(mtdCogs), format: 'currency', sub: 'incl. estimated tuning COS' },
    { key: 'projected_month_revenue', label: 'Projected month revenue', value: round2(projectedMonth), format: 'currency', sub: `run-rate ${fmtMoney(mtdDailyAvg)}/day over ${ctx.elapsedDays} of ${ctx.daysInMonth} days` },
    { key: 'projected_month_gp', label: 'Projected month GP', value: round2(projectedGp), format: 'currency', sub: `at ${fmtPct(mtdGm)} GM` },
  ]
}

// â”€â”€ Chart-of-accounts list for the frontend's tick-boxes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function accountKind(a: GlAccount): MgmtAccountRow['kind'] {
  const t = (a.type || '').toLowerCase()
  const cls = (a.classification || '').toLowerCase()
  if (t === 'income' || t === 'otherincome' || cls === 'income') return 'income'
  if (t === 'costofsales' || cls === 'costofsales') return 'cogs'
  if (cls === 'asset' || a.code.indexOf('1-') === 0) return 'asset'
  return 'other'
}

// â”€â”€ Main entry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function computeMgmtDashboard(
  db: SupabaseClient,
  opts: { refresh?: boolean } = {},
): Promise<MgmtDashboardPayload> {
  const { data: chartData, error } = await db
    .from('mgmt_dashboard_charts')
    .select('key, title, chart_type, position, enabled, config')
    .order('position', { ascending: true })
  if (error) throw new Error('mgmt_dashboard_charts load failed: ' + error.message)
  const rows = (chartData || []) as MgmtChartConfigRow[]
  if (!rows.length) throw new Error('mgmt_dashboard_charts is empty â€” apply migration 184')

  // Pull window: wide enough for the weekly buckets of any chart AND the
  // prior-month-same-day KPI. Weeks are derived from the latest GL date
  // (â‰¤ today), so pad the bucket side by a week of slack.
  const today = todayBrisbane()
  let maxWeeks = 5
  for (const r of rows) {
    const wk = Number(r.config?.weeks) || 0
    if (wk > maxWeeks) maxWeeks = wk
  }
  const bucketStart = addDays(mondayOf(today), -7 * maxWeeks)
  const priorMonthStart = addMonths(today, -1)
  const pullStart = bucketStart < priorMonthStart ? bucketStart : priorMonthStart
  const pullEndExclusive = addDays(today, 1)

  const { bundle: src } = await loadSource(db, pullStart, pullEndExclusive, !!opts.refresh)

  // Anchor every window on the latest transaction date (workbook MAX(GL!N)).
  let latest = ''
  for (const r of src.gl) if (r.dateIso > latest) latest = r.dateIso
  if (!latest || latest > today) latest = today
  const ctx = buildCtx(latest)

  const charts: MgmtChart[] = []
  for (const row of rows) {
    if (!row.enabled) continue
    if (row.config?.kind === 'kpis') continue // KPI row is not a chart
    // revenueOrdersLeads runs its own (separately cached) MYOB+Monday pull â€”
    // async, unlike the bundle-fed builders.
    const c = row.config?.kind === 'revenueOrdersLeads'
      ? await buildRevenueOrdersLeads(db, row, !!opts.refresh)
      : buildChart(row, ctx, src)
    if (c) charts.push(c)
  }

  const kpiRow = rows.find(r => r.config?.kind === 'kpis')
  const kpis = kpiRow && kpiRow.enabled ? buildKpis(kpiRow.config || {}, ctx, src) : []

  const accounts: MgmtAccountRow[] = src.accounts
    .filter(a => !a.isHeader && a.code)
    .map(a => ({ code: a.code, name: a.name, kind: accountKind(a) }))

  return {
    generatedAt: new Date().toISOString(),
    kpis,
    charts,
    config: { charts: rows, accounts },
  }
}
