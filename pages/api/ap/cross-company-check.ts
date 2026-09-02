// pages/api/ap/cross-company-check.ts
// Read-only dry run of the cross-company duplicate check (lib/ap-cross-company).
//
// Nothing is posted, changed or logged — it asks MYOB the same question the AP
// pipeline asks before entering an invoice, and shows the answer. Built so a
// suspected double-up can be tested against the LIVE files without waiting for
// the supplier to send another invoice (Chris 2026-09-02, after the JMACX
// invoice was paid in both companies).
//
//   GET /api/ap/cross-company-check
//        ?supplier=JMACX
//        &number=JM-88213          (optional, but it is the strong signal)
//        &amount=47937.90          (optional; the amount net needs >= $1,000)
//        &date=2026-08-14          (optional, defaults to today)
//        &entity=VPS               (optional: the file you'd be posting INTO,
//                                   default VPS. Only affects which file has
//                                   its BILLS skipped as already-covered.)
//
// Permission: view:supplier_invoices — the same people who work /ap.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../lib/authServer'
import { findCrossCompanyDuplicate, describeCrossCompanyHit, type CompanyFileLabel } from '../../../lib/ap-cross-company'

export const config = { maxDuration: 120 }

export default withAuth('view:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }

  const q = req.query
  const supplier = String(q.supplier || '').trim()
  if (!supplier) {
    return res.status(400).json({
      error: 'supplier is required',
      example: '/api/ap/cross-company-check?supplier=JMACX&number=JM-88213&amount=47937.90&date=2026-08-14',
    })
  }

  const number = q.number ? String(q.number).trim() : null
  const amountRaw = q.amount ? Number(String(q.amount).replace(/[^0-9.-]/g, '')) : NaN
  const amount = Number.isFinite(amountRaw) ? amountRaw : null
  const date = q.date ? String(q.date).trim() : null
  const entity: CompanyFileLabel = String(q.entity || 'VPS').toUpperCase() === 'JAWS' ? 'JAWS' : 'VPS'
  const dayWindow = q.days ? Number(q.days) : undefined

  try {
    const r = await findCrossCompanyDuplicate({
      postingTo: entity,
      supplierName: supplier,
      supplierInvoiceNumber: number,
      totalAmount: amount,
      invoiceDate: date,
      dayWindow: Number.isFinite(dayWindow as number) ? dayWindow : undefined,
    })

    // Mirror exactly what the AP pipeline would do with this result, so the dry
    // run answers the real question — "would this have been flagged?" — rather
    // than just listing documents.
    const wouldFlag = r.hits.length > 0 || r.incomplete
    return res.status(200).json({
      askedAbout: { supplier, number, amount, date, postingTo: entity },
      wouldFlag,
      verdict: r.hits.length > 0
        ? `FLAGGED — ${r.hits.length} matching document${r.hits.length === 1 ? '' : 's'} found; this invoice would NOT auto-post.`
        : r.incomplete
          ? 'FLAGGED — the search could not complete, so a double-up cannot be ruled out.'
          : 'No match. This invoice would proceed on the cross-company check.',
      hits: r.hits.map(h => ({ ...h, summary: describeCrossCompanyHit(h) })),
      searchIncomplete: r.incomplete,
      notes: r.notes,
    })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Check failed' })
  }
})
