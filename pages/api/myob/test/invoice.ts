// pages/api/myob/test/invoice.ts
// Proof-of-life: fetch the most recent Sale Invoice from MYOB via the direct
// API to confirm the OAuth + CF credentials chain works end-to-end. This is
// Stage 1's success condition — if this works, Stages 2+ are unblocked.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAdmin, getSessionUser } from '../../../../lib/auth'
import { getConnection, myobFetch } from '../../../../lib/myob'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAdmin(req, res, async () => {
    const user = await getSessionUser(req)
    const label = String(req.query.label || 'JAWS')
    const conn = await getConnection(label)
    if (!conn) { res.status(404).json({ error: `No active MYOB connection '${label}'` }); return }
    if (!conn.company_file_id) { res.status(400).json({ error: 'Connection has no company file selected' }); return }

    try {
      // Grab the newest sale invoice. `$top=1` + `$orderby=Date desc` limits
      // the payload so we can verify connectivity without pulling large data.
      const path = `/accountright/${conn.company_file_id}/Sale/Invoice`
      const { status, data } = await myobFetch(conn.id, path, {
        query: { '$top': 1, '$orderby': 'Date desc' },
        performedBy: user?.id || null,
      })
      if (status !== 200) {
        res.status(status).json({ error: 'MYOB returned non-200', status, data })
        return
      }
      const first = data?.Items?.[0]
      res.status(200).json({
        ok: true,
        connection: { label: conn.label, companyFileName: conn.company_file_name },
        invoiceCount: data?.Count ?? null,
        sample: first ? {
          Number: first.Number,
          Date: first.Date,
          CustomerName: first?.Customer?.Name,
          TotalAmount: first.TotalAmount,
          Status: first.Status,
        } : null,
        diagnostic: {
          myobTotalMatchingFilter: data?.Count,
          returnedInThisPage: data?.Items?.length ?? 0,
          nextPageLink: data?.NextPageLink || null,
        },
      })
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Unknown error' })
    }
  })
}
