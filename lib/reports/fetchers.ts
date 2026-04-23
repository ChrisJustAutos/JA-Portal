// lib/reports/fetchers.ts
// SERVER-ONLY — don't import from client components.
// Each fetcher returns a section-specific data shape.
//
// All $ values returned are EX-GST (the GST audit fix from phase 5 applies here too).

import { cdataQuery } from '../cdata'
import { invoiceExGst, lineExGst, toNum, asBool } from '../gst'

// ── Helpers ──────────────────────────────────────────────────────────

type Entity = 'JAWS' | 'VPS'
type DateRange = { periodStart: string; periodEnd: string }

function rowsToObjects(raw: any): any[] {
  if (!raw?.results?.[0]) return []
  const cols: string[] = (raw.results[0].schema || []).map((c: any) => c.columnName)
  const rows: any[][] = raw.results[0].rows || []
  return rows.map(r => {
    const o: any = {}
    cols.forEach((c, i) => { o[c] = r[i] })
    return o
  })
}

function catalogFor(entity: Entity): string {
  return entity === 'JAWS' ? 'MYOB_POWERBI_JAWS' : 'MYOB_POWERBI_VPS'
}

// ── KPI SUMMARY ──────────────────────────────────────────────────────
// Top-line numbers per entity: revenue, receivables, stock, payables, net.

export interface KpiSummaryData {
  entities: Array<{
    entity: Entity
    revenueExGst: number
    receivablesExGst: number
    openInvoiceCount: number
    payablesExGst: number
    openBillCount: number
    stockValueExGst: number | null      // JAWS only
    incomeFromPnlExGst: number
    cosFromPnlExGst: number
    overheadsFromPnlExGst: number
    netExGst: number
  }>
}

export async function fetchKpiSummary(
  entities: Entity[],
  range: DateRange,
): Promise<KpiSummaryData> {
  const results = await Promise.all(entities.map(async (entity) => {
    const cat = catalogFor(entity)

    // All 5 queries in parallel — was sequential, saves 10-15s
    const [invRes, openInvRes, openBillsRes, stockRes, pnlRes] = await Promise.all([
      cdataQuery(entity,
        `SELECT [TotalAmount],[TotalTax] FROM [${cat}].[MYOB].[SaleInvoices] WHERE [Date] >= '${range.periodStart}' AND [Date] <= '${range.periodEnd}' AND [TotalAmount] > 0`
      ).catch(() => null),
      cdataQuery(entity,
        `SELECT [TotalAmount],[TotalTax],[BalanceDueAmount] FROM [${cat}].[MYOB].[SaleInvoices] WHERE [Status] = 'Open' AND [BalanceDueAmount] > 0`
      ).catch(() => null),
      cdataQuery(entity,
        `SELECT [TotalAmount],[TotalTax],[BalanceDueAmount] FROM [${cat}].[MYOB].[PurchaseBills] WHERE [Status] = 'Open' AND [BalanceDueAmount] > 0`
      ).catch(() => null),
      entity === 'JAWS'
        ? cdataQuery(entity, `SELECT SUM([CurrentValue]) AS v FROM [${cat}].[MYOB].[Items]`).catch(() => null)
        : Promise.resolve(null),
      cdataQuery(entity,
        `SELECT [AccountDisplayID],[AccountTotal] FROM [${cat}].[MYOB].[ProfitAndLossSummaryReport] WHERE [StartDate] = '${range.periodStart}' AND [EndDate] = '${range.periodEnd}'`
      ).catch(() => null),
    ])

    const invRows = rowsToObjects(invRes)
    const revenueExGst = invRows.reduce((s, r) => s + invoiceExGst(toNum(r.TotalAmount), toNum(r.TotalTax)), 0)

    const openInvRows = rowsToObjects(openInvRes)
    const receivablesExGst = openInvRows.reduce((s, r) => {
      const total = toNum(r.TotalAmount)
      const tax = toNum(r.TotalTax)
      const bal = toNum(r.BalanceDueAmount)
      const balTax = total > 0 ? (tax * bal) / total : 0
      return s + (bal - balTax)
    }, 0)

    const openBillsRows = rowsToObjects(openBillsRes)
    const payablesExGst = openBillsRows.reduce((s, r) => {
      const total = toNum(r.TotalAmount)
      const tax = toNum(r.TotalTax)
      const bal = toNum(r.BalanceDueAmount)
      const balTax = total > 0 ? (tax * bal) / total : 0
      return s + (bal - balTax)
    }, 0)

    // Stock value (JAWS only — CurrentValue is always ex-GST)
    const stockValueExGst: number | null = entity === 'JAWS'
      ? toNum(rowsToObjects(stockRes)[0]?.v)
      : null

    // P&L income, COS, overheads (always ex-GST)
    const pnl = rowsToObjects(pnlRes)
    const incomeFromPnlExGst = pnl.filter(r => String(r.AccountDisplayID || '').startsWith('4-') && toNum(r.AccountTotal) > 0).reduce((s, r) => s + toNum(r.AccountTotal), 0)
    const cosFromPnlExGst    = pnl.filter(r => String(r.AccountDisplayID || '').startsWith('5-') && toNum(r.AccountTotal) > 0).reduce((s, r) => s + toNum(r.AccountTotal), 0)
    const overheadsFromPnlExGst = pnl.filter(r => String(r.AccountDisplayID || '').startsWith('6-') && toNum(r.AccountTotal) > 0).reduce((s, r) => s + toNum(r.AccountTotal), 0)
    const netExGst = incomeFromPnlExGst - cosFromPnlExGst - overheadsFromPnlExGst

    return {
      entity,
      revenueExGst,
      receivablesExGst,
      openInvoiceCount: openInvRows.length,
      payablesExGst,
      openBillCount: openBillsRows.length,
      stockValueExGst,
      incomeFromPnlExGst,
      cosFromPnlExGst,
      overheadsFromPnlExGst,
      netExGst,
    }
  }))

  return { entities: results }
}

// ── P&L SUMMARY ──────────────────────────────────────────────────────

export interface PnLSummaryData {
  entities: Array<{
    entity: Entity
    income: Array<{ account: string; code: string; amount: number }>
    cos: Array<{ account: string; code: string; amount: number }>
    overheads: Array<{ account: string; code: string; amount: number }>
    totalIncome: number
    totalCos: number
    totalOverheads: number
    grossProfit: number
    netProfit: number
  }>
}

export async function fetchPnlSummary(entities: Entity[], range: DateRange): Promise<PnLSummaryData> {
  const results = await Promise.all(entities.map(async (entity) => {
    const cat = catalogFor(entity)
    const pnlRes = await cdataQuery(entity,
      `SELECT [AccountName],[AccountDisplayID],[AccountTotal] FROM [${cat}].[MYOB].[ProfitAndLossSummaryReport] WHERE [StartDate] = '${range.periodStart}' AND [EndDate] = '${range.periodEnd}' ORDER BY [AccountDisplayID]`
    ).catch(() => null)
    const rows = rowsToObjects(pnlRes)
    const mapRow = (r: any) => ({ account: String(r.AccountName || ''), code: String(r.AccountDisplayID || ''), amount: toNum(r.AccountTotal) })
    const income = rows.filter(r => String(r.AccountDisplayID || '').startsWith('4-') && toNum(r.AccountTotal) > 0).map(mapRow).sort((a,b) => b.amount - a.amount)
    const cos = rows.filter(r => String(r.AccountDisplayID || '').startsWith('5-') && toNum(r.AccountTotal) > 0).map(mapRow).sort((a,b) => b.amount - a.amount)
    const overheads = rows.filter(r => String(r.AccountDisplayID || '').startsWith('6-') && toNum(r.AccountTotal) > 0).map(mapRow).sort((a,b) => b.amount - a.amount)
    const totalIncome = income.reduce((s, r) => s + r.amount, 0)
    const totalCos = cos.reduce((s, r) => s + r.amount, 0)
    const totalOverheads = overheads.reduce((s, r) => s + r.amount, 0)
    return {
      entity, income, cos, overheads,
      totalIncome, totalCos, totalOverheads,
      grossProfit: totalIncome - totalCos,
      netProfit: totalIncome - totalCos - totalOverheads,
    }
  }))
  return { entities: results }
}

// ── TOP CUSTOMERS ────────────────────────────────────────────────────

export interface TopCustomersData {
  entities: Array<{
    entity: Entity
    customers: Array<{ name: string; revenueExGst: number; invoiceCount: number }>
  }>
}

export async function fetchTopCustomers(entities: Entity[], range: DateRange, limit = 10): Promise<TopCustomersData> {
  const results = await Promise.all(entities.map(async (entity) => {
    const cat = catalogFor(entity)
    const invRes = await cdataQuery(entity,
      `SELECT [CustomerName],[TotalAmount],[TotalTax] FROM [${cat}].[MYOB].[SaleInvoices] WHERE [Date] >= '${range.periodStart}' AND [Date] <= '${range.periodEnd}' AND [TotalAmount] > 0`
    ).catch(() => null)
    const rows = rowsToObjects(invRes)
    const byCustomer = new Map<string, { revenueExGst: number; invoiceCount: number }>()
    for (const r of rows) {
      const name = r.CustomerName
      if (!name) continue
      const rev = invoiceExGst(toNum(r.TotalAmount), toNum(r.TotalTax))
      if (rev <= 0) continue
      const e = byCustomer.get(name) || { revenueExGst: 0, invoiceCount: 0 }
      e.revenueExGst += rev
      e.invoiceCount += 1
      byCustomer.set(name, e)
    }
    const customers = Array.from(byCustomer.entries())
      .map(([name, v]) => ({ name, revenueExGst: v.revenueExGst, invoiceCount: v.invoiceCount }))
      .sort((a, b) => b.revenueExGst - a.revenueExGst)
      .slice(0, limit)
    return { entity, customers }
  }))
  return { entities: results }
}

// ── RECEIVABLES AGING ────────────────────────────────────────────────

export interface AgingData {
  entities: Array<{
    entity: Entity
    buckets: {
      current: number     // 0-30 days
      days30: number      // 31-60
      days60: number      // 61-90
      days90: number      // 91+
    }
    total: number
    oldest: Array<{ customerOrSupplier: string; invoiceNumber: string; date: string; daysOld: number; balanceExGst: number }>
  }>
}

function bucketize(invoices: any[], asOf: Date, customerField: string) {
  const buckets = { current: 0, days30: 0, days60: 0, days90: 0 }
  const items = invoices.map(r => {
    const total = toNum(r.TotalAmount)
    const tax = toNum(r.TotalTax)
    const bal = toNum(r.BalanceDueAmount)
    const balTax = total > 0 ? (tax * bal) / total : 0
    const balEx = bal - balTax
    const invDate = r.Date ? new Date(r.Date) : null
    const days = invDate ? Math.floor((asOf.getTime() - invDate.getTime()) / 86400000) : 0
    return {
      customerOrSupplier: String(r[customerField] || ''),
      invoiceNumber: String(r.Number || ''),
      date: r.Date,
      daysOld: days,
      balanceExGst: balEx,
    }
  })
  for (const it of items) {
    if (it.daysOld <= 30) buckets.current += it.balanceExGst
    else if (it.daysOld <= 60) buckets.days30 += it.balanceExGst
    else if (it.daysOld <= 90) buckets.days60 += it.balanceExGst
    else buckets.days90 += it.balanceExGst
  }
  const total = buckets.current + buckets.days30 + buckets.days60 + buckets.days90
  const oldest = items.sort((a, b) => b.daysOld - a.daysOld).slice(0, 10)
  return { buckets, total, oldest }
}

export async function fetchReceivablesAging(entities: Entity[]): Promise<AgingData> {
  const asOf = new Date()
  const results = await Promise.all(entities.map(async (entity) => {
    const cat = catalogFor(entity)
    const res = await cdataQuery(entity,
      `SELECT [Number],[Date],[CustomerName],[TotalAmount],[TotalTax],[BalanceDueAmount] FROM [${cat}].[MYOB].[SaleInvoices] WHERE [Status] = 'Open' AND [BalanceDueAmount] > 0`
    ).catch(() => null)
    const { buckets, total, oldest } = bucketize(rowsToObjects(res), asOf, 'CustomerName')
    return { entity, buckets, total, oldest }
  }))
  return { entities: results }
}

export async function fetchPayablesAging(entities: Entity[]): Promise<AgingData> {
  const asOf = new Date()
  const results = await Promise.all(entities.map(async (entity) => {
    const cat = catalogFor(entity)
    const res = await cdataQuery(entity,
      `SELECT [Number],[Date],[SupplierName],[TotalAmount],[TotalTax],[BalanceDueAmount] FROM [${cat}].[MYOB].[PurchaseBills] WHERE [Status] = 'Open' AND [BalanceDueAmount] > 0`
    ).catch(() => null)
    const { buckets, total, oldest } = bucketize(rowsToObjects(res), asOf, 'SupplierName')
    return { entity, buckets, total, oldest }
  }))
  return { entities: results }
}

// ── STOCK SUMMARY / REORDER / DEAD ───────────────────────────────────

export interface StockSummaryData {
  totalValueExGst: number
  itemCount: number
  itemsBelowReorder: number
  itemsWithNoSales90d: number
}

export async function fetchStockSummary(): Promise<StockSummaryData> {
  const res = await cdataQuery('JAWS',
    `SELECT [Name],[CurrentValue],[QuantityOnHand],[MinimumLevel] FROM [MYOB_POWERBI_JAWS].[MYOB].[Items] WHERE [IsInventoried] = 1`
  ).catch(() => null)
  const rows = rowsToObjects(res)
  const totalValueExGst = rows.reduce((s, r) => s + toNum(r.CurrentValue), 0)
  const itemsBelowReorder = rows.filter(r => toNum(r.MinimumLevel) > 0 && toNum(r.QuantityOnHand) < toNum(r.MinimumLevel)).length
  // itemsWithNoSales90d is a rough estimate — set to 0 for now without more sales data
  return {
    totalValueExGst,
    itemCount: rows.length,
    itemsBelowReorder,
    itemsWithNoSales90d: 0,
  }
}

export interface StockReorderData {
  items: Array<{ name: string; sku: string; onHand: number; reorderLevel: number; shortBy: number; avgCost: number }>
}

export async function fetchStockReorder(): Promise<StockReorderData> {
  const res = await cdataQuery('JAWS',
    `SELECT [Name],[Number],[QuantityOnHand],[MinimumLevel],[AverageCost] FROM [MYOB_POWERBI_JAWS].[MYOB].[Items] WHERE [IsInventoried] = 1 AND [MinimumLevel] > 0`
  ).catch(() => null)
  const rows = rowsToObjects(res)
  const items = rows
    .map(r => ({
      name: String(r.Name || ''),
      sku: String(r.Number || ''),
      onHand: toNum(r.QuantityOnHand),
      reorderLevel: toNum(r.MinimumLevel),
      avgCost: toNum(r.AverageCost),
    }))
    .filter(r => r.onHand < r.reorderLevel)
    .map(r => ({ ...r, shortBy: r.reorderLevel - r.onHand }))
    .sort((a, b) => b.shortBy - a.shortBy)
    .slice(0, 50)
  return { items }
}

export interface StockDeadData {
  items: Array<{ name: string; sku: string; heldValueExGst: number; onHand: number; lastSoldDays: number | null }>
  totalHeldValueExGst: number
}

export async function fetchStockDead(): Promise<StockDeadData> {
  // Dead stock: inventoried items with on-hand > 0 that haven't sold in 90+ days
  const d90 = new Date(); d90.setDate(d90.getDate() - 90)
  const d90Str = d90.toISOString().slice(0, 10)

  const itemsRes = await cdataQuery('JAWS',
    `SELECT [Name],[Number],[CurrentValue],[QuantityOnHand] FROM [MYOB_POWERBI_JAWS].[MYOB].[Items] WHERE [IsInventoried] = 1 AND [QuantityOnHand] > 0 AND [CurrentValue] > 0`
  ).catch(() => null)
  const allItems = rowsToObjects(itemsRes)

  // Pull invoices from last 90 days to find which items DID sell
  const invRes = await cdataQuery('JAWS',
    `SELECT [ID] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Date] >= '${d90Str}'`
  ).catch(() => null)
  const invIds = new Set(rowsToObjects(invRes).map(r => String(r.ID)))

  let soldItemNumbers = new Set<string>()
  if (invIds.size > 0) {
    const linesRes = await cdataQuery('JAWS',
      `SELECT [SaleInvoiceId],[ItemNumber] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems] WHERE [ItemNumber] IS NOT NULL`
    ).catch(() => null)
    const lines = rowsToObjects(linesRes)
    for (const l of lines) {
      if (invIds.has(String(l.SaleInvoiceId)) && l.ItemNumber) {
        soldItemNumbers.add(String(l.ItemNumber).trim())
      }
    }
  }

  const items = allItems
    .filter(r => !soldItemNumbers.has(String(r.Number || '').trim()))
    .map(r => ({
      name: String(r.Name || ''),
      sku: String(r.Number || ''),
      heldValueExGst: toNum(r.CurrentValue),
      onHand: toNum(r.QuantityOnHand),
      lastSoldDays: null as number | null,
    }))
    .sort((a, b) => b.heldValueExGst - a.heldValueExGst)
    .slice(0, 50)

  const totalHeldValueExGst = items.reduce((s, r) => s + r.heldValueExGst, 0)
  return { items, totalHeldValueExGst }
}

// ── DISTRIBUTOR RANKING ──────────────────────────────────────────────

export interface DistributorRankingData {
  distributors: Array<{
    name: string
    tuning: number
    parts: number
    oil: number
    total: number
    invoiceCount: number
  }>
  totals: { tuning: number; parts: number; oil: number; total: number }
}

const TUNING = ['4-1905','4-1910','4-1915','4-1920']
const PARTS  = ['4-1000','4-1401','4-1602','4-1701','4-1802','4-1803','4-1805','4-1807','4-1811','4-1813','4-1814','4-1821','4-1861']
const OIL    = ['4-1060']
const DIST_EXCLUDED = new Set([
  'vps','vehicle performance solutions t/a just autos',
  'duncan scott','kent dalton','wade kelly','mark cooper','sean poiani',
  'allsorts mechanical','hd automotive','mccormacks 4wd','vito media',
  'michael scalzo','macpherson witham','mark naidoo','anthony barraball',
])

export async function fetchDistributorRanking(range: DateRange): Promise<DistributorRankingData> {
  const invRes = await cdataQuery('JAWS',
    `SELECT [ID],[CustomerName],[IsTaxInclusive] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Date] >= '${range.periodStart}' AND [Date] <= '${range.periodEnd}'`
  ).catch(() => null)
  const invRows = rowsToObjects(invRes)
  const invById = new Map<string, any>()
  for (const r of invRows) {
    invById.set(String(r.ID), { customerName: r.CustomerName, isTaxInclusive: asBool(r.IsTaxInclusive) })
  }

  const accList = [...TUNING, ...PARTS, ...OIL].map(a => `'${a}'`).join(',')
  const lineRes = await cdataQuery('JAWS',
    `SELECT [SaleInvoiceId],[AccountDisplayID],[TaxCodeCode],[Total] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems] WHERE [AccountDisplayID] IN (${accList})`
  ).catch(() => null)
  const lines = rowsToObjects(lineRes)

  const byDist = new Map<string, { tuning: number; parts: number; oil: number; invoiceIds: Set<string> }>()
  for (const line of lines) {
    const inv = invById.get(String(line.SaleInvoiceId))
    if (!inv) continue
    const rawName: string = String(inv.customerName || '')
    if (DIST_EXCLUDED.has(rawName.toLowerCase())) continue
    const base = rawName.replace(/\s*\(Tuning 2\)\s*$/i, '').replace(/\s*\(Tuning 1\)\s*$/i, '').replace(/\s*\(Tuning\)\s*$/i, '').trim()
    if (!base || DIST_EXCLUDED.has(base.toLowerCase())) continue

    const acc = String(line.AccountDisplayID || '')
    const amt = lineExGst(toNum(line.Total), inv.isTaxInclusive, line.TaxCodeCode)

    if (!byDist.has(base)) byDist.set(base, { tuning: 0, parts: 0, oil: 0, invoiceIds: new Set() })
    const agg = byDist.get(base)!
    if (TUNING.indexOf(acc) >= 0) agg.tuning += amt
    else if (PARTS.indexOf(acc) >= 0) agg.parts += amt
    else if (OIL.indexOf(acc) >= 0) agg.oil += amt
    agg.invoiceIds.add(String(line.SaleInvoiceId))
  }

  const distributors = Array.from(byDist.entries()).map(([name, v]) => ({
    name,
    tuning: Math.round(v.tuning * 100) / 100,
    parts: Math.round(v.parts * 100) / 100,
    oil: Math.round(v.oil * 100) / 100,
    total: Math.round((v.tuning + v.parts + v.oil) * 100) / 100,
    invoiceCount: v.invoiceIds.size,
  })).sort((a, b) => b.total - a.total)

  const totals = {
    tuning: distributors.reduce((s, d) => s + d.tuning, 0),
    parts: distributors.reduce((s, d) => s + d.parts, 0),
    oil: distributors.reduce((s, d) => s + d.oil, 0),
    total: distributors.reduce((s, d) => s + d.total, 0),
  }
  return { distributors, totals }
}

// ── PIPELINE (orders + quotes, JAWS only) ────────────────────────────

export interface PipelineData {
  openOrdersCount: number
  openOrdersValueExGst: number
  openOrdersOwingExGst: number
  convertedCount30d: number
  convertedValue30dExGst: number
  quotesCount: number
  quotesValueExGst: number
  topOpenOrders: Array<{ number: string; customer: string; date: string; valueExGst: number; isPrepaid: boolean }>
}

export async function fetchPipeline(): Promise<PipelineData> {
  const d30 = new Date(); d30.setDate(d30.getDate() - 30)
  const d30Str = d30.toISOString().slice(0, 10)

  const openRes = await cdataQuery('JAWS',
    `SELECT Number, Date, CustomerName, TotalAmount, BalanceDueAmount, TotalTax FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleOrders] WHERE Status = 'Open' ORDER BY Date DESC`
  ).catch(() => null)
  const openOrders = rowsToObjects(openRes).map(o => {
    const total = toNum(o.TotalAmount)
    const tax = toNum(o.TotalTax)
    const bal = toNum(o.BalanceDueAmount)
    const balTax = total > 0 ? (tax * bal) / total : 0
    return {
      number: String(o.Number || ''),
      customer: String(o.CustomerName || ''),
      date: String(o.Date || ''),
      valueExGst: invoiceExGst(total, tax),
      balanceExGst: bal - balTax,
      isPrepaid: bal === 0 && total > 0,
    }
  })

  const convRes = await cdataQuery('JAWS',
    `SELECT TotalAmount, TotalTax FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleOrders] WHERE Status = 'ConvertedToInvoice' AND Date >= '${d30Str}'`
  ).catch(() => null)
  const converted = rowsToObjects(convRes)
  const convertedValue = converted.reduce((s, r) => s + invoiceExGst(toNum(r.TotalAmount), toNum(r.TotalTax)), 0)

  const quotesRes = await cdataQuery('JAWS',
    `SELECT TotalAmount, TotalTax FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleQuotes]`
  ).catch(() => null)
  const quotes = rowsToObjects(quotesRes)
  const quotesValue = quotes.reduce((s, r) => s + invoiceExGst(toNum(r.TotalAmount), toNum(r.TotalTax)), 0)

  return {
    openOrdersCount: openOrders.length,
    openOrdersValueExGst: openOrders.reduce((s, o) => s + o.valueExGst, 0),
    openOrdersOwingExGst: openOrders.reduce((s, o) => s + o.balanceExGst, 0),
    convertedCount30d: converted.length,
    convertedValue30dExGst: convertedValue,
    quotesCount: quotes.length,
    quotesValueExGst: quotesValue,
    topOpenOrders: openOrders.sort((a, b) => b.valueExGst - a.valueExGst).slice(0, 10),
  }
}

// ── TREND CHARTS (6-month income/expense per entity) ─────────────────

export interface TrendChartsData {
  months: string[]  // labels like "Nov 25", "Dec 25", ...
  entities: Array<{
    entity: Entity
    income: number[]
    expenses: number[]
    net: number[]
  }>
}

export async function fetchTrendCharts(entities: Entity[]): Promise<TrendChartsData> {
  const months: Array<{ year: number; month: number; label: string; start: string; end: string }> = []
  const now = new Date()
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const pad = (n: number) => String(n).padStart(2, '0')
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
    months.push({
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      label: d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }),
      start: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`,
      end: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(lastDay)}`,
    })
  }

  const entityResults = await Promise.all(entities.map(async (entity) => {
    const cat = catalogFor(entity)
    // Fire ALL 12 queries (6 months × 2 metrics) in parallel — was sequential, now parallel.
    // This turns a 30-60s wait into a single round-trip of ~3-5s.
    const perMonthResults = await Promise.all(months.map(async (m) => {
      const [incRes, expRes] = await Promise.all([
        cdataQuery(entity,
          `SELECT SUM([AccountTotal]) AS v FROM [${cat}].[MYOB].[ProfitAndLossSummaryReport] WHERE [AccountDisplayID] LIKE '4-%' AND [StartDate] = '${m.start}' AND [EndDate] = '${m.end}'`
        ).catch(() => null),
        cdataQuery(entity,
          `SELECT SUM([AccountTotal]) AS v FROM [${cat}].[MYOB].[ProfitAndLossSummaryReport] WHERE ([AccountDisplayID] LIKE '5-%' OR [AccountDisplayID] LIKE '6-%') AND [StartDate] = '${m.start}' AND [EndDate] = '${m.end}'`
        ).catch(() => null),
      ])
      return {
        income: toNum(rowsToObjects(incRes)[0]?.v),
        expenses: toNum(rowsToObjects(expRes)[0]?.v),
      }
    }))
    const income = perMonthResults.map(r => r.income)
    const expenses = perMonthResults.map(r => r.expenses)
    const net = income.map((v, i) => v - (expenses[i] || 0))
    return { entity, income, expenses, net }
  }))

  return {
    months: months.map(m => m.label),
    entities: entityResults,
  }
}

// ══════════════════════════════════════════════════════════════════════
// SALES SECTIONS — combine MYOB + Monday.com
// ══════════════════════════════════════════════════════════════════════
// These three sections expect a `MondaySalesData` payload that the
// /api/reports/generate endpoint fetches upfront via monday-fetcher.ts.
// We keep these fetchers separate because they don't go through cdataQuery.

import type { MondaySalesData } from './monday-fetcher'

// ── SALES FUNNEL ──────────────────────────────────────────────────────
// Full-funnel view: Leads → Quotes Sent → Quotes Won → MYOB Orders
// Gives conversion percentages at each stage.

export interface SalesFunnelData {
  stages: Array<{ label: string; count: number; value: number; source: 'Monday' | 'MYOB'; note?: string }>
  conversions: Array<{ from: string; to: string; pct: number }>
  periodLabel: string
}

export async function fetchSalesFunnel(
  monday: MondaySalesData | null,
  myobPipeline: PipelineData,
  range: DateRange,
): Promise<SalesFunnelData> {
  // Monday.com: total active leads across all rep boards right now.
  // "Period-aware" doesn't cleanly apply to leads (they're snapshot state),
  // so we label them "currently open" but still include them in the funnel.
  const totalLeads = monday?.activeLeads?.length || 0
  const leadValue = monday?.activeLeads?.reduce((sum, l) => {
    const n = parseFloat((l.quoteValue || '0').replace(/[^0-9.]/g, ''))
    return sum + (isFinite(n) ? n : 0)
  }, 0) || 0

  // Monday.com quotes — aggregate across all rep boards.
  // "Quote Sent" + "3 Days" + "14 Days" + "Follow Up Done" = quote-sent stages.
  const QUOTE_SENT_STATUSES = ['Quote Sent', '3 Days', '14 Days', 'Follow Up Done', 'Quote On Hold', 'RLMNA']
  const QUOTE_WON_STATUSES = ['Quote Won']
  const QUOTE_LOST_STATUSES = ['Quote Lost']

  let quotesSentCount = 0, quotesSentValue = 0
  let quotesWonCount = 0, quotesWonValue = 0
  let quotesLostCount = 0, quotesLostValue = 0
  for (const repBoard of monday?.quotes || []) {
    for (const [status, stat] of Object.entries(repBoard.stats || {})) {
      if (QUOTE_SENT_STATUSES.includes(status)) {
        quotesSentCount += stat.count
        quotesSentValue += stat.value
      }
      if (QUOTE_WON_STATUSES.includes(status)) {
        quotesWonCount += stat.count
        quotesWonValue += stat.value
      }
      if (QUOTE_LOST_STATUSES.includes(status)) {
        quotesLostCount += stat.count
        quotesLostValue += stat.value
      }
    }
  }

  // MYOB converted orders in last 30d as the "Order placed" step.
  const ordersCount = myobPipeline.convertedCount30d || 0
  const ordersValue = myobPipeline.convertedValue30dExGst || 0

  const stages = [
    { label: 'Active Leads',   count: totalLeads,       value: leadValue,        source: 'Monday' as const, note: 'Current open leads (snapshot)' },
    { label: 'Quotes Sent',    count: quotesSentCount,  value: quotesSentValue,  source: 'Monday' as const },
    { label: 'Quotes Won',     count: quotesWonCount,   value: quotesWonValue,   source: 'Monday' as const },
    { label: 'Orders Placed',  count: ordersCount,      value: ordersValue,      source: 'MYOB' as const, note: 'Last 30 days, ex-GST' },
  ]

  const conversions: Array<{ from: string; to: string; pct: number }> = []
  for (let i = 1; i < stages.length; i++) {
    const prev = stages[i - 1]
    const curr = stages[i]
    if (prev.count > 0) {
      conversions.push({ from: prev.label, to: curr.label, pct: Math.round((curr.count / prev.count) * 100) })
    }
  }

  return {
    stages,
    conversions,
    periodLabel: `${range.periodStart} to ${range.periodEnd}`,
  }
}

// ── SALES REP SCORECARD ───────────────────────────────────────────────
// Per rep: active leads + quotes by status + won value + conversion.

export interface SalesRepScorecardData {
  reps: Array<{
    rep: string
    fullName: string
    activeLeads: number
    quotesSent: number
    quotesSentValue: number
    quotesWon: number
    quotesWonValue: number
    quotesLost: number
    conversionPct: number | null    // won / (won + lost)
  }>
  totals: {
    activeLeads: number
    quotesSent: number
    quotesWon: number
    quotesWonValue: number
  }
}

export function fetchSalesRepScorecard(monday: MondaySalesData | null): SalesRepScorecardData {
  const QUOTE_SENT_STATUSES = ['Quote Sent', '3 Days', '14 Days', 'Follow Up Done', 'Quote On Hold', 'RLMNA']
  const reps: SalesRepScorecardData['reps'] = []

  for (const repBoard of monday?.quotes || []) {
    const activeLeads = (monday?.activeLeads || []).filter(l => l.rep === repBoard.rep).length
    let quotesSent = 0, quotesSentValue = 0
    let quotesWon = 0, quotesWonValue = 0
    let quotesLost = 0

    for (const [status, stat] of Object.entries(repBoard.stats || {})) {
      if (QUOTE_SENT_STATUSES.includes(status)) {
        quotesSent += stat.count
        quotesSentValue += stat.value
      }
      if (status === 'Quote Won') {
        quotesWon += stat.count
        quotesWonValue += stat.value
      }
      if (status === 'Quote Lost') {
        quotesLost += stat.count
      }
    }

    const decided = quotesWon + quotesLost
    const conversionPct = decided > 0 ? Math.round((quotesWon / decided) * 100) : null

    reps.push({
      rep: repBoard.rep,
      fullName: repBoard.full,
      activeLeads,
      quotesSent,
      quotesSentValue,
      quotesWon,
      quotesWonValue,
      quotesLost,
      conversionPct,
    })
  }

  reps.sort((a, b) => b.quotesWonValue - a.quotesWonValue)

  return {
    reps,
    totals: {
      activeLeads: reps.reduce((s, r) => s + r.activeLeads, 0),
      quotesSent:  reps.reduce((s, r) => s + r.quotesSent, 0),
      quotesWon:   reps.reduce((s, r) => s + r.quotesWon, 0),
      quotesWonValue: reps.reduce((s, r) => s + r.quotesWonValue, 0),
    },
  }
}

// ── SALES PIPELINE COMBINED ───────────────────────────────────────────
// Enhanced version of the existing `pipeline` section that ALSO includes
// Monday.com context. We keep the MYOB pipeline data AND add Monday summary.

export interface SalesPipelineCombinedData {
  myob: PipelineData
  monday: {
    activeLeadsTotal: number
    quotesSentTotal: number
    quotesSentValue: number
    ordersThisPeriodCount: number
    ordersThisPeriodValue: number
    activeLeadsByStatus: Array<{ status: string; count: number }>
  } | null
}

export function fetchSalesPipelineCombined(
  monday: MondaySalesData | null,
  myobPipeline: PipelineData,
): SalesPipelineCombinedData {
  if (!monday) return { myob: myobPipeline, monday: null }

  const QUOTE_SENT_STATUSES = ['Quote Sent', '3 Days', '14 Days', 'Follow Up Done', 'Quote On Hold', 'RLMNA']
  let quotesSentTotal = 0, quotesSentValue = 0
  for (const repBoard of monday.quotes || []) {
    for (const [status, stat] of Object.entries(repBoard.stats || {})) {
      if (QUOTE_SENT_STATUSES.includes(status)) {
        quotesSentTotal += stat.count
        quotesSentValue += stat.value
      }
    }
  }

  // Breakdown of active leads by their "Not Done" sub-status
  const leadStatusCounts = new Map<string, number>()
  for (const lead of monday.activeLeads || []) {
    const s = lead.status || 'Unknown'
    leadStatusCounts.set(s, (leadStatusCounts.get(s) || 0) + 1)
  }
  const activeLeadsByStatus = Array.from(leadStatusCounts.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count)

  return {
    myob: myobPipeline,
    monday: {
      activeLeadsTotal: monday.activeLeads?.length || 0,
      quotesSentTotal,
      quotesSentValue,
      ordersThisPeriodCount: monday.orders?.totalOrders || 0,
      ordersThisPeriodValue: monday.orders?.totalValue || 0,
      activeLeadsByStatus,
    },
  }
}

// ══════════════════════════════════════════════════════════════════════
// ATTRIBUTION SECTIONS (Connect column aware)
// ══════════════════════════════════════════════════════════════════════
// These sections rely on the "Quote Selection" Connect column on Orders
// (and eventually Dist Booking). They gracefully handle empty/partial
// backfill by showing linkage completeness prominently.

import type { SalesAttributionData } from './monday-fetcher'

// ── SALES REP SCORECARD V2 ────────────────────────────────────────────
// Dual-attribution: quote-month AND order-month, plus tracking completeness.

export interface SalesRepScorecardV2Data {
  attribution: SalesAttributionData | null
  empty: boolean    // true if no data at all (e.g. API failure)
}

export function fetchSalesRepScorecardV2(
  attribution: SalesAttributionData | null,
): SalesRepScorecardV2Data {
  return {
    attribution,
    empty: attribution == null,
  }
}

// ── SALES QUOTE AGING ─────────────────────────────────────────────────
// Shows how long quotes took to convert into orders.

export interface SalesQuoteAgingData {
  attribution: SalesAttributionData | null
  empty: boolean
}

export function fetchSalesQuoteAging(
  attribution: SalesAttributionData | null,
): SalesQuoteAgingData {
  return {
    attribution,
    empty: attribution == null,
  }
}

// ── SALES MONTH TREND ─────────────────────────────────────────────────
// Shows conversion trend across prior months (picks up backfill progress).

export interface SalesMonthTrendData {
  attribution: SalesAttributionData | null
  empty: boolean
}

export function fetchSalesMonthTrend(
  attribution: SalesAttributionData | null,
): SalesMonthTrendData {
  return {
    attribution,
    empty: attribution == null,
  }
}

// ──────────────────────────────────────────────────────────────────────
// CALL ANALYTICS FETCHERS
// ──────────────────────────────────────────────────────────────────────
// Source: Supabase `calls` + `call_analysis` tables. No MYOB involvement.
// All fetchers use a service-role Supabase client (same pattern as the
// rest of the portal's server-side code).

import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _callsSb: SupabaseClient | null = null
function callsSupabase(): SupabaseClient {
  if (_callsSb) return _callsSb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing for call analytics fetchers')
  _callsSb = createClient(url, key, { auth: { persistSession: false } })
  return _callsSb
}

// Sales-rep extensions that we coach. Other extensions (manager 202, office
// staff 300/211, etc.) are excluded from coaching metrics — they skew the
// team average and don't receive Slack coaching posts either.
// Keep this in sync with /opt/ja-cdr-sync/analyse.js + slack-poster.js.
const SALES_REP_EXTENSIONS = new Set(['201', '203', '204', '999', '4001'])

// ── TEAM SCORE TREND ──────────────────────────────────────────────────
// Daily team avg sales_score over the period. One point per day.

export interface CallsTeamTrendData {
  days: Array<{ date: string; avgScore: number | null; callCount: number }>
  totals: { calls: number; scoredCalls: number; avgScore: number | null }
}

export async function fetchCallsTeamTrend(range: DateRange): Promise<CallsTeamTrendData> {
  const sb = callsSupabase()
  const startIso = `${range.periodStart}T00:00:00.000Z`
  const endIso = `${range.periodEnd}T23:59:59.999Z`

  const { data, error } = await sb
    .from('calls')
    .select('call_date, sales_score, agent_ext')
    .gte('call_date', startIso)
    .lte('call_date', endIso)
    .not('sales_score', 'is', null)

  if (error) {
    return { days: [], totals: { calls: 0, scoredCalls: 0, avgScore: null } }
  }

  // Filter to sales reps only
  const rows = (data || []).filter((r: any) => r.agent_ext && SALES_REP_EXTENSIONS.has(String(r.agent_ext)))

  // Group by day (YYYY-MM-DD)
  const byDay = new Map<string, { sum: number; count: number }>()
  let totalCalls = 0
  let scoredCalls = 0
  let scoreSum = 0
  for (const r of rows) {
    const day = String(r.call_date).substring(0, 10)
    totalCalls++
    if (typeof r.sales_score === 'number') {
      scoredCalls++
      scoreSum += r.sales_score
      const e = byDay.get(day) || { sum: 0, count: 0 }
      e.sum += r.sales_score
      e.count += 1
      byDay.set(day, e)
    }
  }

  // Emit a row per day in the window so the chart has gaps rather than
  // auto-interpolating — keeps the reader honest about days with no data.
  const days: Array<{ date: string; avgScore: number | null; callCount: number }> = []
  const start = new Date(range.periodStart + 'T00:00:00Z')
  const end = new Date(range.periodEnd + 'T00:00:00Z')
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().substring(0, 10)
    const b = byDay.get(key)
    days.push({
      date: key,
      avgScore: b ? Math.round((b.sum / b.count) * 10) / 10 : null,
      callCount: b?.count ?? 0,
    })
  }

  return {
    days,
    totals: {
      calls: totalCalls,
      scoredCalls,
      avgScore: scoredCalls > 0 ? Math.round((scoreSum / scoredCalls) * 10) / 10 : null,
    },
  }
}

// ── CALL ACTIVITY ─────────────────────────────────────────────────────
// Raw counts and durations per rep. NOT gated by whether the call was
// coached — this is the unfiltered activity view. Lets a manager see that
// a rep is making calls even if coaching data is sparse.

export interface CallsActivityData {
  reps: Array<{
    agentExt: string
    agentName: string | null
    totalCalls: number
    answeredCalls: number
    outboundCalls: number
    inboundCalls: number
    totalBillSec: number
    avgBillSec: number
    avgBillSecAnswered: number
  }>
  team: {
    totalCalls: number
    totalBillSec: number
    avgBillSec: number
  }
}

export async function fetchCallsActivity(range: DateRange): Promise<CallsActivityData> {
  const sb = callsSupabase()
  const startIso = `${range.periodStart}T00:00:00.000Z`
  const endIso = `${range.periodEnd}T23:59:59.999Z`

  const { data, error } = await sb
    .from('calls')
    .select('agent_ext, agent_name, direction, disposition, billsec_seconds')
    .gte('call_date', startIso)
    .lte('call_date', endIso)

  if (error) {
    return { reps: [], team: { totalCalls: 0, totalBillSec: 0, avgBillSec: 0 } }
  }

  const rows = (data || []).filter((r: any) => r.agent_ext && SALES_REP_EXTENSIONS.has(String(r.agent_ext)))

  const byRep = new Map<string, {
    agentName: string | null
    totalCalls: number; answeredCalls: number
    outboundCalls: number; inboundCalls: number
    totalBillSec: number; answeredBillSec: number
  }>()
  let teamCalls = 0
  let teamBillSec = 0
  for (const r of rows) {
    const ext = String(r.agent_ext)
    teamCalls++
    const sec = Number(r.billsec_seconds) || 0
    teamBillSec += sec
    const agg = byRep.get(ext) || {
      agentName: r.agent_name || null,
      totalCalls: 0, answeredCalls: 0,
      outboundCalls: 0, inboundCalls: 0,
      totalBillSec: 0, answeredBillSec: 0,
    }
    if (!agg.agentName && r.agent_name) agg.agentName = r.agent_name
    agg.totalCalls++
    agg.totalBillSec += sec
    if (r.disposition === 'ANSWERED') { agg.answeredCalls++; agg.answeredBillSec += sec }
    if (r.direction === 'outbound') agg.outboundCalls++
    if (r.direction === 'inbound')  agg.inboundCalls++
    byRep.set(ext, agg)
  }

  const reps = Array.from(byRep.entries())
    .map(([agentExt, v]) => ({
      agentExt,
      agentName: v.agentName,
      totalCalls: v.totalCalls,
      answeredCalls: v.answeredCalls,
      outboundCalls: v.outboundCalls,
      inboundCalls: v.inboundCalls,
      totalBillSec: v.totalBillSec,
      avgBillSec: v.totalCalls > 0 ? Math.round(v.totalBillSec / v.totalCalls) : 0,
      avgBillSecAnswered: v.answeredCalls > 0 ? Math.round(v.answeredBillSec / v.answeredCalls) : 0,
    }))
    .sort((a, b) => b.totalCalls - a.totalCalls)

  return {
    reps,
    team: {
      totalCalls: teamCalls,
      totalBillSec: teamBillSec,
      avgBillSec: teamCalls > 0 ? Math.round(teamBillSec / teamCalls) : 0,
    },
  }
}

// ── REP LEADERBOARD ───────────────────────────────────────────────────
// Per-rep coaching metrics: scored-call count, avg score, flagged count,
// top outcome. Sorted by avg score desc (high performers first).

export interface CallsRepLeaderboardData {
  reps: Array<{
    agentExt: string
    agentName: string | null
    scoredCalls: number
    avgScore: number | null
    minScore: number | null
    maxScore: number | null
    flaggedCount: number     // calls with sales_score < 40
    topOutcome: string | null // most common outcome_classification
  }>
}

export async function fetchCallsRepLeaderboard(range: DateRange): Promise<CallsRepLeaderboardData> {
  const sb = callsSupabase()
  const startIso = `${range.periodStart}T00:00:00.000Z`
  const endIso = `${range.periodEnd}T23:59:59.999Z`

  const { data, error } = await sb
    .from('calls')
    .select('agent_ext, agent_name, sales_score, outcome_classification')
    .gte('call_date', startIso)
    .lte('call_date', endIso)
    .not('sales_score', 'is', null)

  if (error) return { reps: [] }
  const rows = (data || []).filter((r: any) => r.agent_ext && SALES_REP_EXTENSIONS.has(String(r.agent_ext)))

  const byRep = new Map<string, {
    agentName: string | null
    scores: number[]
    flagged: number
    outcomes: Map<string, number>
  }>()
  for (const r of rows) {
    const ext = String(r.agent_ext)
    const existing = byRep.get(ext)
    const agg: {
      agentName: string | null
      scores: number[]
      flagged: number
      outcomes: Map<string, number>
    } = existing || {
      agentName: r.agent_name || null,
      scores: [] as number[],
      flagged: 0,
      outcomes: new Map<string, number>(),
    }
    if (!agg.agentName && r.agent_name) agg.agentName = r.agent_name
    if (typeof r.sales_score === 'number') {
      agg.scores.push(r.sales_score)
      if (r.sales_score < 40) agg.flagged++
    }
    if (r.outcome_classification) {
      agg.outcomes.set(r.outcome_classification, (agg.outcomes.get(r.outcome_classification) || 0) + 1)
    }
    byRep.set(ext, agg)
  }

  const reps = Array.from(byRep.entries())
    .map(([agentExt, v]) => {
      const n = v.scores.length
      const sum = v.scores.reduce((s, x) => s + x, 0)
      const avg = n > 0 ? Math.round((sum / n) * 10) / 10 : null
      let topOutcome: string | null = null
      let topCount = 0
      for (const [oc, c] of v.outcomes) {
        if (c > topCount) { topCount = c; topOutcome = oc }
      }
      return {
        agentExt,
        agentName: v.agentName,
        scoredCalls: n,
        avgScore: avg,
        minScore: n > 0 ? Math.min(...v.scores) : null,
        maxScore: n > 0 ? Math.max(...v.scores) : null,
        flaggedCount: v.flagged,
        topOutcome,
      }
    })
    .sort((a, b) => {
      // Nulls sort last. Then by avgScore desc.
      if (a.avgScore == null && b.avgScore == null) return 0
      if (a.avgScore == null) return 1
      if (b.avgScore == null) return -1
      return b.avgScore - a.avgScore
    })

  return { reps }
}

// ── OUTCOME BREAKDOWN ─────────────────────────────────────────────────
// Distribution of outcome_classification values across scored calls in
// the period. Shape is a simple list of {outcome, count, pct}.

export interface CallsOutcomesData {
  total: number
  outcomes: Array<{ outcome: string; count: number; pct: number }>
}

export async function fetchCallsOutcomes(range: DateRange): Promise<CallsOutcomesData> {
  const sb = callsSupabase()
  const startIso = `${range.periodStart}T00:00:00.000Z`
  const endIso = `${range.periodEnd}T23:59:59.999Z`

  const { data, error } = await sb
    .from('calls')
    .select('agent_ext, outcome_classification')
    .gte('call_date', startIso)
    .lte('call_date', endIso)
    .not('outcome_classification', 'is', null)

  if (error) return { total: 0, outcomes: [] }
  const rows = (data || []).filter((r: any) => r.agent_ext && SALES_REP_EXTENSIONS.has(String(r.agent_ext)))

  const counts = new Map<string, number>()
  for (const r of rows) {
    const o = String(r.outcome_classification)
    counts.set(o, (counts.get(o) || 0) + 1)
  }
  const total = rows.length
  const outcomes = Array.from(counts.entries())
    .map(([outcome, count]) => ({
      outcome,
      count,
      pct: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count)

  return { total, outcomes }
}

// ── FLAGGED CALLS ─────────────────────────────────────────────────────
// Individual calls with sales_score < FLAG_THRESHOLD. Used by managers
// to spot-check calls that need coaching intervention. Ordered by score
// ascending (worst first) then date desc.

const FLAG_THRESHOLD = 40

export interface CallsFlaggedData {
  threshold: number
  count: number
  calls: Array<{
    callId: string
    callDate: string
    agentExt: string
    agentName: string | null
    externalNumber: string | null
    direction: string | null
    billSec: number
    score: number
    outcome: string | null
    summaryShort: string | null   // first ~180 chars of coaching_summary
  }>
}

export async function fetchCallsFlagged(range: DateRange): Promise<CallsFlaggedData> {
  const sb = callsSupabase()
  const startIso = `${range.periodStart}T00:00:00.000Z`
  const endIso = `${range.periodEnd}T23:59:59.999Z`

  const { data, error } = await sb
    .from('calls')
    .select('id, call_date, agent_ext, agent_name, external_number, direction, billsec_seconds, sales_score, outcome_classification, coaching_summary')
    .gte('call_date', startIso)
    .lte('call_date', endIso)
    .lt('sales_score', FLAG_THRESHOLD)
    .not('sales_score', 'is', null)
    .order('sales_score', { ascending: true })
    .order('call_date', { ascending: false })
    .limit(50)

  if (error) return { threshold: FLAG_THRESHOLD, count: 0, calls: [] }
  const rows = (data || []).filter((r: any) => r.agent_ext && SALES_REP_EXTENSIONS.has(String(r.agent_ext)))

  const calls = rows.map((r: any) => {
    const s = r.coaching_summary || ''
    const short = s.length > 180 ? s.substring(0, 180).trim() + '…' : s || null
    return {
      callId: r.id,
      callDate: r.call_date,
      agentExt: String(r.agent_ext),
      agentName: r.agent_name || null,
      externalNumber: r.external_number || null,
      direction: r.direction || null,
      billSec: Number(r.billsec_seconds) || 0,
      score: Number(r.sales_score),
      outcome: r.outcome_classification || null,
      summaryShort: short,
    }
  })

  return { threshold: FLAG_THRESHOLD, count: calls.length, calls }
}

// ── TOP OBJECTIONS ────────────────────────────────────────────────────
// Frequency-counted list of objections raised by callers across scored
// calls in the period. Sources `objections_raised` (jsonb array of
// {text,category}?) on the calls table — populated by analyse.js when
// Claude's rubric response contains objection data. If the column is
// empty or the shape varies, returns an empty outcomes list.
//
// NOTE: the exact shape of objections_raised hasn't been verified from
// production yet. The guard below handles: null, string[], {text,count}[],
// and {objection,count}[] so a mismatch degrades gracefully instead of
// throwing. Once a sample row is inspected we'll tighten the types.

export interface CallsObjectionsData {
  total: number                  // total distinct objection mentions
  callsWithObjections: number    // how many calls had at least one
  objections: Array<{ text: string; count: number; pct: number }>
}

export async function fetchCallsObjections(range: DateRange): Promise<CallsObjectionsData> {
  const sb = callsSupabase()
  const startIso = `${range.periodStart}T00:00:00.000Z`
  const endIso = `${range.periodEnd}T23:59:59.999Z`

  const { data, error } = await sb
    .from('calls')
    .select('agent_ext, objections_raised')
    .gte('call_date', startIso)
    .lte('call_date', endIso)
    .not('objections_raised', 'is', null)

  if (error) return { total: 0, callsWithObjections: 0, objections: [] }
  const rows = (data || []).filter((r: any) => r.agent_ext && SALES_REP_EXTENSIONS.has(String(r.agent_ext)))

  const counts = new Map<string, number>()
  let totalMentions = 0
  let callsWithObjections = 0

  for (const r of rows) {
    const raw = r.objections_raised
    let items: string[] = []
    if (Array.isArray(raw)) {
      items = raw
        .map((o: any) => {
          if (typeof o === 'string') return o
          if (o && typeof o === 'object') return o.text || o.objection || o.label || null
          return null
        })
        .filter((x: any): x is string => typeof x === 'string' && x.length > 0)
    } else if (typeof raw === 'string') {
      // If stored as a single string, split on newlines/commas as a best-effort.
      items = raw.split(/[\n;]+/).map(s => s.trim()).filter(Boolean)
    }
    if (items.length > 0) callsWithObjections++
    for (const it of items) {
      const key = it.toLowerCase().trim()
      counts.set(key, (counts.get(key) || 0) + 1)
      totalMentions++
    }
  }

  const objections = Array.from(counts.entries())
    .map(([text, count]) => ({
      text,
      count,
      pct: totalMentions > 0 ? Math.round((count / totalMentions) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15)

  return { total: totalMentions, callsWithObjections, objections }
}
