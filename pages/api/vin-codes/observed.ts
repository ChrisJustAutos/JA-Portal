// pages/api/vin-codes/observed.ts
// Returns distinct VIN prefixes seen on JAWS sales invoices, with occurrence counts.
// The admin UI uses this to show "prefixes that exist in MYOB but aren't mapped yet".

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../../lib/auth'
import { cdataQuery } from '../../../lib/cdata'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      const result = await cdataQuery('JAWS', `
        SELECT
          LEFT([CustomerPurchaseOrderNumber], 4) AS prefix,
          COUNT(*) AS occurrences,
          MAX([CustomerPurchaseOrderNumber]) AS sample_value
        FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
        WHERE [CustomerPurchaseOrderNumber] IS NOT NULL
          AND LEN([CustomerPurchaseOrderNumber]) >= 8
        GROUP BY LEFT([CustomerPurchaseOrderNumber], 4)
        ORDER BY COUNT(*) DESC
      `)
      const rows = result?.results?.[0]?.rows || []
      const observed = rows.map((r: any[]) => ({
        prefix: r[0],
        occurrences: Number(r[1]),
        sample_value: r[2],
      }))
      res.status(200).json({ observed, count: observed.length })
    } catch (e: any) {
      console.error('observed VINs error:', e)
      res.status(500).json({ error: e.message || 'Failed to load observed VINs' })
    }
  })
}
