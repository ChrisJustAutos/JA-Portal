// pages/api/dashboard.ts — Fast core data only (invoices, P&L, stock summaries)
// Trends loaded separately via /api/trends
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery, currentMonthRange } from '../../lib/cdata'

export const config = { maxDuration: 60 }

async function safe(fn: () => Promise<any>) {
  try { return await fn() } catch(e: any) { console.error(e.message?.substring(0,80)); return null }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      const { start, end } = currentMonthRange()

      // Run 6 JAWS + 5 VPS queries in parallel — no trend data here
      const [
        jawsRecent, jawsOpen, jawsTopCust, jawsPnL, jawsStockSum, jawsBills,
        vpsRecent,  vpsOpen,  vpsTopCust,  vpsPnL,  vpsBills,
      ] = await Promise.all([
        safe(() => cdataQuery('JAWS', `SELECT TOP 20 [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],[InvoiceType] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC`)),
        safe(() => cdataQuery('JAWS', `SELECT [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
        safe(() => cdataQuery('JAWS', `SELECT [CustomerName], SUM([TotalAmount]) AS TotalRevenue, COUNT(*) AS InvoiceCount FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Date] >= '${start}' AND [Date] <= '${end}' AND [TotalAmount] > 0 GROUP BY [CustomerName] ORDER BY TotalRevenue DESC LIMIT 10`)),
        safe(() => cdataQuery('JAWS', `SELECT [AccountName],[AccountDisplayID],[AccountTotal] FROM [MYOB_POWERBI_JAWS].[MYOB].[ProfitAndLossSummaryReport] WHERE [StartDate] = '${start}' AND [EndDate] = '${end}' ORDER BY [AccountDisplayID]`)),
        safe(() => cdataQuery('JAWS', `SELECT SUM([CurrentValue]) AS TotalStockValue, COUNT(*) AS ItemCount FROM [MYOB_POWERBI_JAWS].[MYOB].[Items]`)),
        safe(() => cdataQuery('JAWS', `SELECT TOP 15 [Number],[Date],[SupplierName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_JAWS].[MYOB].[PurchaseBills] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
        safe(() => cdataQuery('VPS',  `SELECT TOP 20 [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],[InvoiceType] FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC`)),
        safe(() => cdataQuery('VPS',  `SELECT [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
        safe(() => cdataQuery('VPS',  `SELECT [CustomerName], SUM([TotalAmount]) AS TotalRevenue, COUNT(*) AS InvoiceCount FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] WHERE [Date] >= '${start}' AND [Date] <= '${end}' AND [TotalAmount] > 0 GROUP BY [CustomerName] ORDER BY TotalRevenue DESC LIMIT 10`)),
        safe(() => cdataQuery('VPS',  `SELECT [AccountName],[AccountDisplayID],[AccountTotal] FROM [MYOB_POWERBI_VPS].[MYOB].[ProfitAndLossSummaryReport] WHERE [StartDate] = '${start}' AND [EndDate] = '${end}' ORDER BY [AccountDisplayID]`)),
        safe(() => cdataQuery('VPS',  `SELECT TOP 10 [Number],[Date],[SupplierName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_VPS].[MYOB].[PurchaseBills] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
      ])

      res.status(200).json({
        fetchedAt: new Date().toISOString(),
        period: { start, end },
        jaws: { recentInvoices: jawsRecent, openInvoices: jawsOpen, topCustomers: jawsTopCust, pnl: jawsPnL, stockItems: null, stockSummary: jawsStockSum, openBills: jawsBills },
        vps:  { recentInvoices: vpsRecent,  openInvoices: vpsOpen,  topCustomers: vpsTopCust,  pnl: vpsPnL,  openBills: vpsBills, stockSummary: null },
      })
    } catch(err: any) {
      console.error('Dashboard error:', err)
      res.status(500).json({ error: err.message })
    }
  })
}
