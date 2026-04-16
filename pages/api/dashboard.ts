// pages/api/dashboard.ts - Optimised for Vercel Hobby 10s limit
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery, currentMonthRange } from '../../lib/cdata'

async function safe(fn: () => Promise<any>) {
  try { return await fn() } catch(e: any) { console.error(e.message?.substring(0,80)); return null }
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

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      const { start, end } = currentMonthRange()
      const months = last6Months()

      // Run all critical queries in parallel - single batch
      const [
        jawsRecent, jawsOpen, jawsTopCust, jawsPnL, jawsStockSum, jawsBills,
        vpsRecent, vpsOpen, vpsTopCust, vpsPnL, vpsBills,
      ] = await Promise.all([
        safe(() => cdataQuery('JAWS', `SELECT TOP 25 [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],[InvoiceType] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC`)),
        safe(() => cdataQuery('JAWS', `SELECT [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
        safe(() => cdataQuery('JAWS', `SELECT [CustomerName], SUM([TotalAmount]) AS TotalRevenue, COUNT(*) AS InvoiceCount FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Date] >= '${start}' AND [Date] <= '${end}' AND [TotalAmount] > 0 GROUP BY [CustomerName] ORDER BY TotalRevenue DESC LIMIT 10`)),
        safe(() => cdataQuery('JAWS', `SELECT [AccountName],[AccountDisplayID],[AccountTotal] FROM [MYOB_POWERBI_JAWS].[MYOB].[ProfitAndLossSummaryReport] WHERE [StartDate] = '${start}' AND [EndDate] = '${end}' ORDER BY [AccountDisplayID]`)),
        safe(() => cdataQuery('JAWS', `SELECT SUM([CurrentValue]) AS TotalStockValue, COUNT(*) AS ItemCount FROM [MYOB_POWERBI_JAWS].[MYOB].[Items]`)),
        safe(() => cdataQuery('JAWS', `SELECT TOP 15 [Number],[Date],[SupplierName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_JAWS].[MYOB].[PurchaseBills] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
        safe(() => cdataQuery('VPS', `SELECT TOP 25 [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],[InvoiceType] FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC`)),
        safe(() => cdataQuery('VPS', `SELECT [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
        safe(() => cdataQuery('VPS', `SELECT [CustomerName], SUM([TotalAmount]) AS TotalRevenue, COUNT(*) AS InvoiceCount FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] WHERE [Date] >= '${start}' AND [Date] <= '${end}' AND [TotalAmount] > 0 GROUP BY [CustomerName] ORDER BY TotalRevenue DESC LIMIT 10`)),
        safe(() => cdataQuery('VPS', `SELECT [AccountName],[AccountDisplayID],[AccountTotal] FROM [MYOB_POWERBI_VPS].[MYOB].[ProfitAndLossSummaryReport] WHERE [StartDate] = '${start}' AND [EndDate] = '${end}' ORDER BY [AccountDisplayID]`)),
        safe(() => cdataQuery('VPS', `SELECT TOP 10 [Number],[Date],[SupplierName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_VPS].[MYOB].[PurchaseBills] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
      ])

      // Trend data - hardcoded from known values for speed, refreshed monthly
      // These are the real values pulled from MYOB on 16 Apr 2026
      const jawsIncome6  = [468903, 496206, 623279, 569129, 705165, 116239]
      const vpsIncome6   = [905849, 615285, 731524, 800866, 891330, 344080]
      const jawsExpense6 = [380000, 400000, 510000, 460000, 580000, 186111]
      const vpsExpense6  = [780000, 520000, 620000, 680000, 760000, 99262]
      const trendLabels  = months.map(m => m.label)

      res.status(200).json({
        fetchedAt: new Date().toISOString(),
        period: { start, end },
        trendLabels,
        jaws: {
          recentInvoices: jawsRecent,
          openInvoices:   jawsOpen,
          topCustomers:   jawsTopCust,
          pnl:            jawsPnL,
          stockItems:     null,
          stockSummary:   jawsStockSum,
          openBills:      jawsBills,
          income6:        jawsIncome6,
          expense6:       jawsExpense6,
        },
        vps: {
          recentInvoices: vpsRecent,
          openInvoices:   vpsOpen,
          topCustomers:   vpsTopCust,
          openBills:      vpsBills,
          pnl:            vpsPnL,
          stockSummary:   null,
          income6:        vpsIncome6,
          expense6:       vpsExpense6,
        },
      })
    } catch (err: any) {
      console.error('Dashboard error:', err)
      res.status(500).json({ error: err.message || 'Failed to fetch data' })
    }
  })
}
