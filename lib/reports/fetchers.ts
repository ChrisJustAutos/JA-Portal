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
