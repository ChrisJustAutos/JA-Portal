// pages/api/trends.ts — 6-month trend data with cache
//
// GST NOTE: All amounts are from ProfitAndLossSummaryReport.AccountTotal, which
// MYOB always stores ex-GST by convention. No normalisation needed.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'

export const config = { maxDuration: 30 }

// RETIRED 2026-07-14: this endpoint served 6-month income/expense trends from
// MYOB's ProfitAndLossSummaryReport via CData. CData is decommissioned and
// AccountRight has no P&L endpoint, so P&L was dropped from the portal. The
// endpoint now returns empty (zeroed) series so the dashboard trend chart
// renders flat rather than erroring; the whole panel is being removed.

function last6Months() {
  const months = []
  const now = new Date()
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push({ label: d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }) })
  }
  return months
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const months = last6Months()
    const zeros = months.map(() => 0)
    res.status(200).json({
      amountsAreExGst: true,
      retired: true,
      trendLabels: months.map(m => m.label),
      jawsIncome6: zeros, vpsIncome6: zeros, jawsExpense6: zeros, vpsExpense6: zeros,
    })
  })
}
