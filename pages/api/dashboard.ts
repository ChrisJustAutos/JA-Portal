import type { NextApiRequest, NextApiResponse } from 'next'
import { isAuthenticated } from '../../lib/auth'
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
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1, label: d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }) })
  }
  return months
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isAuthenticated(req)) { res.status(401).json({ error: 'Unauthorised' }); return }
  try {
    const { start, end } = currentMonthRange()
    const months = last6Months()
    const [
      jawsRecent, jawsOpen, jawsTopCust, jawsPnL,
      jawsStock, jawsStockSum, jawsBills,
      vpsRecent, vpsOpen, vpsTopCust, vpsBills,
      vpsPnL, vpsStockSum,
      ...trendResults
    ] = await Promise.allSettled([
      getJawsRecentInvoices(), getJawsOpenInvoices(), getJawsTopCustomers(start, end), getJawsPnL(start, end),
      getJawsStockItems(), getJawsStockSummary(), getJawsOpenBills(),
      getVpsRecentInvoices(), getVpsOpenInvoices(), getVpsTopCustomers(start, end), getVpsOpenBills(),
      getVpsPnL(start, end), getVpsStockSummary(),
      ...months.map(m => getMonthlyTrend('MYOB_POWERBI_JAWS', m.year, m.month)),
      ...months.map(m => getMonthlyTrend('MYOB_POWERBI_VPS', m.year, m.month)),
      ...months.map(m => getMonthlyExpenseTrend('MYOB_POWERBI_JAWS', m.year, m.month)),
      ...months.map(m => getMonthlyExpenseTrend('MYOB_POWERBI_VPS', m.year, m.month)),
    ])
    const safe = (r: PromiseSettledResult<any>) => r.status === 'fulfilled' ? r.value : null
    const extractVal = (r: PromiseSettledResult<any>): number => r.status === 'fulfilled' ? (r.value?.results?.[0]?.rows?.[0]?.[0] ?? 0) : 0
    const jawsIncome6  = trendResults.slice(0, 6).map(r => extractVal(r))
    const vpsIncome6   = trendResults.slice(6, 12).map(r => extractVal(r))
    const jawsExpense6 = trendResults.slice(12, 18).map(r => extractVal(r))
    const vpsExpense6  = trendResults.slice(18, 24).map(r => extractVal(r))
    res.status(200).json({
      fetchedAt: new Date().toISOString(), period: { start, end },
      trendLabels: months.map(m => m.label),
      jaws: { recentInvoices: safe(jawsRecent), openInvoices: safe(jawsOpen), topCustomers: safe(jawsTopCust), pnl: safe(jawsPnL), stockItems: safe(jawsStock), stockSummary: safe(jawsStockSum), openBills: safe(jawsBills), income6: jawsIncome6, expense6: jawsExpense6 },
      vps:  { recentInvoices: safe(vpsRecent),  openInvoices: safe(vpsOpen),  topCustomers: safe(vpsTopCust), openBills: safe(vpsBills), pnl: safe(vpsPnL), stockSummary: safe(vpsStockSum), income6: vpsIncome6, expense6: vpsExpense6 },
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch data' })
  }
}
