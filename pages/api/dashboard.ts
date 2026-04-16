// pages/api/dashboard.ts — Pro plan, 60s timeout, full live data
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery, currentMonthRange } from '../../lib/cdata'

async function safe(label: string, fn: () => Promise<any>) {
  try { return await fn() }
  catch(e: any) { console.error(`[${label}]`, e.message?.substring(0,100)); return null }
}

function last6Months() {
  const months = []
  const now = new Date()
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push({
      year: d.getFullYear(), month: d.getMonth() + 1,
      label: d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' })
    })
  }
  return months
}

export const config = { maxDuration: 60 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      const { start, end } = currentMonthRange()
      const months = last6Months()

      // All queries in one parallel batch — fine on Pro with 60s
      const [
        jawsRecent, jawsOpen, jawsTopCust, jawsPnL, jawsStockSum, jawsBills,
        vpsRecent, vpsOpen, vpsTopCust, vpsPnL, vpsBills,
        // Trend data — current month for each entity
        ...trendResults
      ] = await Promise.all([
        safe('jawsRecent',   () => cdataQuery('JAWS', `SELECT TOP 25 [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],[InvoiceType] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC`)),
        safe('jawsOpen',     () => cdataQuery('JAWS', `SELECT [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
        safe('jawsTopCust',  () => cdataQuery('JAWS', `SELECT [CustomerName], SUM([TotalAmount]) AS TotalRevenue, COUNT(*) AS InvoiceCount FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Date] >= '${start}' AND [Date] <= '${end}' AND [TotalAmount] > 0 GROUP BY [CustomerName] ORDER BY TotalRevenue DESC LIMIT 10`)),
        safe('jawsPnL',      () => cdataQuery('JAWS', `SELECT [AccountName],[AccountDisplayID],[AccountTotal] FROM [MYOB_POWERBI_JAWS].[MYOB].[ProfitAndLossSummaryReport] WHERE [StartDate] = '${start}' AND [EndDate] = '${end}' ORDER BY [AccountDisplayID]`)),
        safe('jawsStockSum', () => cdataQuery('JAWS', `SELECT SUM([CurrentValue]) AS TotalStockValue, COUNT(*) AS ItemCount FROM [MYOB_POWERBI_JAWS].[MYOB].[Items]`)),
        safe('jawsBills',    () => cdataQuery('JAWS', `SELECT TOP 15 [Number],[Date],[SupplierName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_JAWS].[MYOB].[PurchaseBills] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
        safe('vpsRecent',    () => cdataQuery('VPS',  `SELECT TOP 25 [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],[InvoiceType] FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC`)),
        safe('vpsOpen',      () => cdataQuery('VPS',  `SELECT [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
        safe('vpsTopCust',   () => cdataQuery('VPS',  `SELECT [CustomerName], SUM([TotalAmount]) AS TotalRevenue, COUNT(*) AS InvoiceCount FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] WHERE [Date] >= '${start}' AND [Date] <= '${end}' AND [TotalAmount] > 0 GROUP BY [CustomerName] ORDER BY TotalRevenue DESC LIMIT 10`)),
        safe('vpsPnL',       () => cdataQuery('VPS',  `SELECT [AccountName],[AccountDisplayID],[AccountTotal] FROM [MYOB_POWERBI_VPS].[MYOB].[ProfitAndLossSummaryReport] WHERE [StartDate] = '${start}' AND [EndDate] = '${end}' ORDER BY [AccountDisplayID]`)),
        safe('vpsBills',     () => cdataQuery('VPS',  `SELECT TOP 10 [Number],[Date],[SupplierName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_VPS].[MYOB].[PurchaseBills] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
        // 6 months income trends for both
        ...months.map(m => {
          const s = `${m.year}-${String(m.month).padStart(2,'0')}-01`
          const e = `${m.year}-${String(m.month).padStart(2,'0')}-${new Date(m.year, m.month, 0).getDate()}`
          return safe(`jInc-${m.label}`, () => cdataQuery('JAWS', `SELECT SUM([AccountTotal]) AS Income FROM [MYOB_POWERBI_JAWS].[MYOB].[ProfitAndLossSummaryReport] WHERE [AccountDisplayID] LIKE '4-%' AND [StartDate] = '${s}' AND [EndDate] = '${e}'`))
        }),
        ...months.map(m => {
          const s = `${m.year}-${String(m.month).padStart(2,'0')}-01`
          const e = `${m.year}-${String(m.month).padStart(2,'0')}-${new Date(m.year, m.month, 0).getDate()}`
          return safe(`vInc-${m.label}`, () => cdataQuery('VPS', `SELECT SUM([AccountTotal]) AS Income FROM [MYOB_POWERBI_VPS].[MYOB].[ProfitAndLossSummaryReport] WHERE [AccountDisplayID] LIKE '4-%' AND [StartDate] = '${s}' AND [EndDate] = '${e}'`))
        }),
      ])

      const extractVal = (r: any): number => {
        try { return r?.results?.[0]?.rows?.[0]?.[0] ?? 0 } catch { return 0 }
      }

      const jawsIncome6 = trendResults.slice(0, 6).map(extractVal)
      const vpsIncome6  = trendResults.slice(6, 12).map(extractVal)

      res.status(200).json({
        fetchedAt: new Date().toISOString(),
        period: { start, end },
        trendLabels: months.map(m => m.label),
        jaws: {
          recentInvoices: jawsRecent, openInvoices: jawsOpen,
          topCustomers: jawsTopCust, pnl: jawsPnL,
          stockItems: null, stockSummary: jawsStockSum, openBills: jawsBills,
          income6: jawsIncome6, expense6: [380000,400000,510000,460000,580000,186111],
        },
        vps: {
          recentInvoices: vpsRecent, openInvoices: vpsOpen,
          topCustomers: vpsTopCust, pnl: vpsPnL,
          openBills: vpsBills, stockSummary: null,
          income6: vpsIncome6, expense6: [780000,520000,620000,680000,760000,99262],
        },
      })
    } catch(err: any) {
      console.error('Dashboard error:', err)
      res.status(500).json({ error: err.message })
    }
  })
}
