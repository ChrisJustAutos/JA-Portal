// pages/api/dashboard.ts
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import {
  getJawsRecentInvoices, getJawsOpenInvoices, getJawsTopCustomers, getJawsPnL,
  getJawsStockItems, getJawsStockSummary, getJawsOpenBills,
  getVpsRecentInvoices, getVpsOpenInvoices, getVpsTopCustomers, getVpsOpenBills,
  getVpsPnL, getVpsStockSummary,
  getMonthlyTrend, getMonthlyExpenseTrend,
  currentMonthRange,
} from '../../lib/cdata'

function last6Months() {
  const months = []
  const now = new Date()
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push({
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      label: d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }),
    })
  }
  return months
}

// Wrap each query so a failure returns null instead of crashing everything
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn() }
  catch (e: any) { 
    console.error('Query failed:', e.message?.substring(0, 100))
    return null 
  }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      const { start, end } = currentMonthRange()
      const months = last6Months()

      // Phase 1 — critical data first (invoices + P&L)
      const [
        jawsRecent, jawsOpen, jawsTopCust, jawsPnL,
        vpsRecent, vpsOpen, vpsTopCust, vpsPnL,
      ] = await Promise.all([
        safe(() => getJawsRecentInvoices()),
        safe(() => getJawsOpenInvoices()),
        safe(() => getJawsTopCustomers(start, end)),
        safe(() => getJawsPnL(start, end)),
        safe(() => getVpsRecentInvoices()),
        safe(() => getVpsOpenInvoices()),
        safe(() => getVpsTopCustomers(start, end)),
        safe(() => getVpsPnL(start, end)),
      ])

      // Phase 2 — secondary data
      const [
        jawsStock, jawsStockSum, jawsBills, vpsBills, vpsStockSum,
      ] = await Promise.all([
        safe(() => getJawsStockItems()),
        safe(() => getJawsStockSummary()),
        safe(() => getJawsOpenBills()),
        safe(() => getVpsOpenBills()),
        safe(() => getVpsStockSummary()),
      ])

      // Phase 3 — trend data (run in batches to avoid timeout)
      const jawsTrend = await Promise.all(
        months.map(m => safe(() => getMonthlyTrend('MYOB_POWERBI_JAWS', m.year, m.month)))
      )
      const vpsTrend = await Promise.all(
        months.map(m => safe(() => getMonthlyTrend('MYOB_POWERBI_VPS', m.year, m.month)))
      )
      const jawsExpTrend = await Promise.all(
        months.map(m => safe(() => getMonthlyExpenseTrend('MYOB_POWERBI_JAWS', m.year, m.month)))
      )
      const vpsExpTrend = await Promise.all(
        months.map(m => safe(() => getMonthlyExpenseTrend('MYOB_POWERBI_VPS', m.year, m.month)))
      )

      const extractVal = (r: any): number => r?.results?.[0]?.rows?.[0]?.[0] ?? 0

      res.status(200).json({
        fetchedAt: new Date().toISOString(),
        period: { start, end },
        trendLabels: months.map(m => m.label),
        jaws: {
          recentInvoices: jawsRecent,
          openInvoices:   jawsOpen,
          topCustomers:   jawsTopCust,
          pnl:            jawsPnL,
          stockItems:     jawsStock,
          stockSummary:   jawsStockSum,
          openBills:      jawsBills,
          income6:  jawsTrend.map(extractVal),
          expense6: jawsExpTrend.map(extractVal),
        },
        vps: {
          recentInvoices: vpsRecent,
          openInvoices:   vpsOpen,
          topCustomers:   vpsTopCust,
          openBills:      vpsBills,
          pnl:            vpsPnL,
          stockSummary:   vpsStockSum,
          income6:  vpsTrend.map(extractVal),
          expense6: vpsExpTrend.map(extractVal),
        },
      })
    } catch (err: any) {
      console.error('Dashboard error:', err)
      res.status(500).json({ error: err.message || 'Failed to fetch data' })
    }
  })
}
