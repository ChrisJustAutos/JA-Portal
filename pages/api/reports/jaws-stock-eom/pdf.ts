// pages/api/reports/jaws-stock-eom/pdf.ts
// GET ?month=YYYY-MM[&from=YYYY-MM&to=YYYY-MM] → the report as a PDF download.
// from/to pick the sales-history window, exactly as on the report screen.
//
// Serves the STORED snapshot when there is one, so the PDF matches the screen
// exactly (and downloads in a second). Only builds live when that month has
// never been generated — pressing Rebuild on the page is the way to refresh.
//
// Same gate as the report itself: view:reports AND view:stock — it carries
// costs, margins and supplier pricing.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { buildEomReport, saveSnapshot, loadSnapshot, previousMonth, resolveHistoryWindow } from '../../../../lib/jaws-stock-eom'
import { renderStockEomPdf, stockEomPdfFilename } from '../../../../lib/jaws-stock-eom-pdf'

// A live build reads 13 months of invoice lines out of AccountRight.
export const config = { maxDuration: 300 }

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export default withAuth('view:reports', async (req: NextApiRequest, res: NextApiResponse, user: any) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!roleHasPermission(user.role, 'view:stock')) {
    return res.status(403).json({ error: 'This report includes costs and margins — needs stock access.' })
  }

  const month = String(req.query.month || previousMonth())
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' })
  const from = req.query.from ? String(req.query.from) : null
  const to = req.query.to ? String(req.query.to) : null
  if ((from && !MONTH_RE.test(from)) || (to && !MONTH_RE.test(to))) {
    return res.status(400).json({ error: 'from/to must be YYYY-MM' })
  }
  const want = resolveHistoryWindow(month, from, to)

  try {
    let rep = await loadSnapshot(month)
    // Export what the screen shows: if the stored snapshot was built over a
    // different history window, rebuild rather than hand over other numbers.
    const storedWindow = rep?.history ? `${rep.history.from}:${rep.history.to}` : null
    if (!rep || (storedWindow && storedWindow !== `${want.from}:${want.to}`) || (!storedWindow && (from || to))) {
      rep = await buildEomReport(month, { historyFrom: from, historyTo: to })
      await saveSnapshot(rep, user.id)
    }
    const buffer = await renderStockEomPdf(rep)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${stockEomPdfFilename(rep)}"`)
    res.setHeader('Content-Length', String(buffer.length))
    return res.status(200).send(buffer)
  } catch (e: any) {
    console.error('[jaws-stock-eom/pdf] failed:', e?.message || e)
    return res.status(500).json({ error: (e?.message || String(e)).slice(0, 400) })
  }
})
