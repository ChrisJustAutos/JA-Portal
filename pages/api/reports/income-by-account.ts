// pages/api/reports/income-by-account.ts
//
// Income charged out, grouped by MYOB income account, for a date range.
// Sums sale-invoice LINE totals per account (Account.DisplayID/Name) across
// all invoice types on the chosen company file. This is how you read e.g.
// "labour charged out" (the labour income account) vs parts, etc.
//
// Also reports the earliest/latest invoice date seen per account + overall,
// so you can tell whether the file actually covers the requested window
// (relevant for VPS, where the MechanicDesk→MYOB sync only began ~Oct 2025).
//
// Auth: staff with view:reports, OR X-Service-Token 'reports:read', OR
// Bearer CRON_SECRET. Query: ?label=VPS|JAWS&start=YYYY-MM-DD&end=YYYY-MM-DD
// (end inclusive). GET.

import type { NextApiRequest, NextApiResponse } from 'next'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { validateServiceToken } from '../../../lib/service-auth'
import { fetchSaleInvoicesWithLines } from '../../../lib/myob-reporting'

export const config = { maxDuration: 120 }

function addDay(ymd: string): string {
  const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronOk = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`
  const svcOk = cronOk ? null : await validateServiceToken(req, 'reports:read')
  if (!cronOk && !svcOk) {
    const user = await getCurrentUser(req)
    if (!user || !roleHasPermission(user.role, 'view:reports')) return res.status(401).json({ error: 'Unauthorised' })
  }

  const label = (String(req.query.label || 'VPS').toUpperCase() === 'JAWS' ? 'JAWS' : 'VPS') as 'VPS' | 'JAWS'
  const start = String(req.query.start || '')
  const end = String(req.query.end || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return res.status(400).json({ error: 'start and end (YYYY-MM-DD) required' })
  }

  try {
    const { invoices, lines } = await fetchSaleInvoicesWithLines(label, { start, endExclusive: addDay(end) })
    const invDate = new Map<string, string>()
    for (const inv of invoices) if (inv.Date) invDate.set(inv.ID, inv.Date.slice(0, 10))

    const byAcct = new Map<string, { code: string; name: string; total: number; lineCount: number; minDate: string; maxDate: string }>()
    let overallMin = '9999-99-99', overallMax = '0000-00-00', grand = 0
    for (const l of lines) {
      const code = l.AccountDisplayID || '(none)'
      const d = invDate.get(l.SaleInvoiceId) || ''
      const row = byAcct.get(code) || { code, name: l.AccountName || '', total: 0, lineCount: 0, minDate: '9999-99-99', maxDate: '0000-00-00' }
      row.total += l.Total
      row.lineCount += 1
      if (d) { if (d < row.minDate) row.minDate = d; if (d > row.maxDate) row.maxDate = d }
      byAcct.set(code, row)
      grand += l.Total
      if (d) { if (d < overallMin) overallMin = d; if (d > overallMax) overallMax = d }
    }

    const accounts = Array.from(byAcct.values())
      .map(r => ({ ...r, total: Math.round(r.total * 100) / 100 }))
      .sort((a, b) => b.total - a.total)

    return res.status(200).json({
      ok: true, label, start, end,
      invoiceCount: invoices.length,
      coverage: { earliestInvoice: overallMin === '9999-99-99' ? null : overallMin, latestInvoice: overallMax === '0000-00-00' ? null : overallMax },
      grandTotal: Math.round(grand * 100) / 100,
      note: 'Line totals are GST-exclusive where invoices are tax-exclusive; MYOB Line.Total is the ex-tax line amount.',
      accounts,
    })
  } catch (e: any) {
    console.error('[income-by-account] failed:', e?.message || e)
    return res.status(500).json({ error: (e?.message || String(e)).slice(0, 400) })
  }
}
