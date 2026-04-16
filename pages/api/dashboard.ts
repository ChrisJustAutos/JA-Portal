// pages/api/dashboard.ts — Full dashboard, Pro plan 60s timeout
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery, currentMonthRange } from '../../lib/cdata'

async function safe(fn: () => Promise<any>) {
  try { return await fn() } catch(e: any) { console.error('Query err:', e.message?.substring(0,100)); return null }
}

function last6Months() {
  const months = []
  const now = new Date()
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1, label: d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }) })
  }
  return months
}

function trendQuery(catalog: string, year: number, month: number, type: 'income' | 'expense') {
  const start = `${year}-${String(month).padStart(2,'0')}-01`
  const end   = `${year}-${String(month).padStart(2,'0')}-${new Date(year, month, 0).getDate()}`
  const like  = type === 'income' ? "LIKE '4-%'" : "LIKE '5-%' OR [AccountDisplayID] LIKE '6-%'"
  return cdataQuery(catalog, `SELECT SUM([AccountTotal]) AS Val FROM [${catalog}].[MYOB].[ProfitAndLossSummaryReport] WHERE ([AccountDisplayID] ${like}) AND [StartDate] = '${start}' AND [EndDate] = '${end}'`)
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      const { start, end } = currentMonthRange()
      const months = last6Months()

      // All queries in one parallel batch — 60s is plenty
      const [
        jawsRecent, jawsOpen, jawsTopCust, jawsPnL, jawsStockItems, jawsStockSum, jawsBills,
        vpsRecent, vpsOpen, vpsTopCust, vpsPnL, vpsBills, vpsStockSum,
        // JAWS income trend
        ji0, ji1, ji2, ji3, ji4, ji5,
        // VPS income trend
        vi0, vi1, vi2, vi3, vi4, vi5,
        // JAWS expense trend
        je0, je1, je2, je3, je4, je5,
        // VPS expense trend
        ve0, ve1, ve2, ve3, ve4, ve5,
      ] = await Promise.all([
        // Core data
        safe(() => cdataQuery('JAWS', `SELECT TOP 25 [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],[InvoiceType] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC`)),
        safe(() => cdataQuery('JAWS', `SELECT [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
        safe(() => cdataQuery('JAWS', `SELECT [CustomerName], SUM([TotalAmount]) AS TotalRevenue, COUNT(*) AS InvoiceCount FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Date] >= '${start}' AND [Date] <= '${end}' AND [TotalAmount] > 0 GROUP BY [CustomerName] ORDER BY TotalRevenue DESC LIMIT 12`)),
        safe(() => cdataQuery('JAWS', `SELECT [AccountName],[AccountDisplayID],[AccountTotal] FROM [MYOB_POWERBI_JAWS].[MYOB].[ProfitAndLossSummaryReport] WHERE [StartDate] = '${start}' AND [EndDate] = '${end}' ORDER BY [AccountDisplayID]`)),
        safe(() => cdataQuery('JAWS', `SELECT TOP 30 [Name],[CurrentValue],[QuantityOnHand],[QuantityCommitted],[QuantityAvailable],[AverageCost],[BaseSellingPrice] FROM [MYOB_POWERBI_JAWS].[MYOB].[Items] ORDER BY [CurrentValue] DESC`)),
        safe(() => cdataQuery('JAWS', `SELECT SUM([CurrentValue]) AS TotalStockValue, COUNT(*) AS ItemCount FROM [MYOB_POWERBI_JAWS].[MYOB].[Items]`)),
        safe(() => cdataQuery('JAWS', `SELECT TOP 20 [Number],[Date],[SupplierName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_JAWS].[MYOB].[PurchaseBills] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
        safe(() => cdataQuery('VPS',  `SELECT TOP 25 [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],[InvoiceType] FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC`)),
        safe(() => cdataQuery('VPS',  `SELECT [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
        safe(() => cdataQuery('VPS',  `SELECT [CustomerName], SUM([TotalAmount]) AS TotalRevenue, COUNT(*) AS InvoiceCount FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] WHERE [Date] >= '${start}' AND [Date] <= '${end}' AND [TotalAmount] > 0 GROUP BY [CustomerName] ORDER BY TotalRevenue DESC LIMIT 12`)),
        safe(() => cdataQuery('VPS',  `SELECT [AccountName],[AccountDisplayID],[AccountTotal] FROM [MYOB_POWERBI_VPS].[MYOB].[ProfitAndLossSummaryReport] WHERE [StartDate] = '${start}' AND [EndDate] = '${end}' ORDER BY [AccountDisplayID]`)),
        safe(() => cdataQuery('VPS',  `SELECT TOP 10 [Number],[Date],[SupplierName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_VPS].[MYOB].[PurchaseBills] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
        safe(() => cdataQuery('VPS',  `SELECT SUM([CurrentValue]) AS TotalStockValue, COUNT(*) AS ItemCount FROM [MYOB_POWERBI_VPS].[MYOB].[Items]`)),
        // JAWS income 6 months
        ...months.map(m => safe(() => trendQuery('MYOB_POWERBI_JAWS', m.year, m.month, 'income'))),
        // VPS income 6 months
        ...months.map(m => safe(() => trendQuery('MYOB_POWERBI_VPS', m.year, m.month, 'income'))),
        // JAWS expense 6 months
        ...months.map(m => safe(() => trendQuery('MYOB_POWERBI_JAWS', m.year, m.month, 'expense'))),
        // VPS expense 6 months
        ...months.map(m => safe(() => trendQuery('MYOB_POWERBI_VPS', m.year, m.month, 'expense'))),
      ])

      const v = (r: any) => r?.results?.[0]?.rows?.[0]?.[0] ?? 0

      res.status(200).json({
        fetchedAt: new Date().toISOString(),
        period: { start, end },
        trendLabels: months.map(m => m.label),
        jaws: {
          recentInvoices: jawsRecent,
          openInvoices:   jawsOpen,
          topCustomers:   jawsTopCust,
          pnl:            jawsPnL,
          stockItems:     jawsStockItems,
          stockSummary:   jawsStockSum,
          openBills:      jawsBills,
          income6:  [ji0,ji1,ji2,ji3,ji4,ji5].map(v),
          expense6: [je0,je1,je2,je3,je4,je5].map(v),
        },
        vps: {
          recentInvoices: vpsRecent,
          openInvoices:   vpsOpen,
          topCustomers:   vpsTopCust,
          openBills:      vpsBills,
          pnl:            vpsPnL,
          stockSummary:   vpsStockSum,
          income6:  [vi0,vi1,vi2,vi3,vi4,vi5].map(v),
          expense6: [ve0,ve1,ve2,ve3,ve4,ve5].map(v),
        },
      })
    } catch (err: any) {
      console.error('Dashboard error:', err)
      res.status(500).json({ error: err.message })
    }
  })
}
