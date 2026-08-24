// pages/api/reports/jaws-stock-eom/pdf.ts
// GET ?month=YYYY-MM → the month-end stock report as a PDF download.
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
import { buildEomReport, saveSnapshot, loadSnapshot, previousMonth } from '../../../../lib/jaws-stock-eom'
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

  try {
    let rep = await loadSnapshot(month)
    if (!rep) {
      rep = await buildEomReport(month)
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
