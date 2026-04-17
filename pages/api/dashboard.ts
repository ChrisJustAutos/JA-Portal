// pages/api/dashboard.ts — Sequential small batches to guarantee sub-10s
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery, parseDateRange } from '../../lib/cdata'

export const config = { maxDuration: 60 }

async function safe(fn: () => Promise<any>) {
  try { return await fn() } catch(e: any) { console.error(e.message?.substring(0,60)); return null }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
          const { start, end } = parseDateRange(new URLSearchParams(req.query as Record<string, string>))

    // Batch A: JAWS critical (3 queries)
    const [jawsRecent, jawsOpen, jawsTopCust] = await Promise.all([
      safe(() => cdataQuery('JAWS', `SELECT TOP 20 [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],[InvoiceType] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC`)),
      safe(() => cdataQuery('JAWS', `SELECT [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
      safe(() => cdataQuery('JAWS', `SELECT [CustomerName], SUM([TotalAmount]) AS TotalRevenue, COUNT(*) AS InvoiceCount FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Date] >= '${start}' AND [Date] <= '${end}' AND [TotalAmount] > 0 GROUP BY [CustomerName] ORDER BY TotalRevenue DESC LIMIT 10`)),
    ])

    // Batch B: VPS critical (3 queries)
    const [vpsRecent, vpsOpen, vpsTopCust] = await Promise.all([
      safe(() => cdataQuery('VPS', `SELECT TOP 20 [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],[InvoiceType] FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC`)),
      safe(() => cdataQuery('VPS', `SELECT [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
      safe(() => cdataQuery('VPS', `SELECT [CustomerName], SUM([TotalAmount]) AS TotalRevenue, COUNT(*) AS InvoiceCount FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] WHERE [Date] >= '${start}' AND [Date] <= '${end}' AND [TotalAmount] > 0 GROUP BY [CustomerName] ORDER BY TotalRevenue DESC LIMIT 10`)),
    ])

    // Batch C: P&L both entities (2 queries)
    const [jawsPnL, vpsPnL] = await Promise.all([
      safe(() => cdataQuery('JAWS', `SELECT [AccountName],[AccountDisplayID],[AccountTotal] FROM [MYOB_POWERBI_JAWS].[MYOB].[ProfitAndLossSummaryReport] WHERE [StartDate] = '${start}' AND [EndDate] = '${end}' ORDER BY [AccountDisplayID]`)),
      safe(() => cdataQuery('VPS',  `SELECT [AccountName],[AccountDisplayID],[AccountTotal] FROM [MYOB_POWERBI_VPS].[MYOB].[ProfitAndLossSummaryReport]  WHERE [StartDate] = '${start}' AND [EndDate] = '${end}' ORDER BY [AccountDisplayID]`)),
    ])

    // Batch D: Bills + stock (3 queries)
    const [jawsBills, vpsBills, jawsStockSum] = await Promise.all([
      safe(() => cdataQuery('JAWS', `SELECT TOP 15 [Number],[Date],[SupplierName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_JAWS].[MYOB].[PurchaseBills] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
      safe(() => cdataQuery('VPS',  `SELECT TOP 10 [Number],[Date],[SupplierName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_VPS].[MYOB].[PurchaseBills]  WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)),
      safe(() => cdataQuery('JAWS', `SELECT SUM([CurrentValue]) AS TotalStockValue, COUNT(*) AS ItemCount FROM [MYOB_POWERBI_JAWS].[MYOB].[Items]`)),
    ])

    res.status(200).json({
      fetchedAt: new Date().toISOString(),
      period: { start, end },
      jaws: { recentInvoices: jawsRecent, openInvoices: jawsOpen, topCustomers: jawsTopCust, pnl: jawsPnL, stockItems: null, stockSummary: jawsStockSum, openBills: jawsBills },
      vps:  { recentInvoices: vpsRecent,  openInvoices: vpsOpen,  topCustomers: vpsTopCust,  pnl: vpsPnL,  openBills: vpsBills, stockSummary: null },
    })
  })
}
