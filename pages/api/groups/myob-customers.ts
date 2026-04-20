// pages/api/groups/myob-customers.ts
// Returns a distinct list of MYOB customer names seen on JAWS invoices.
// Used by the admin UI to surface "unclassified" customer cards.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../../lib/auth'
import { cdataQuery } from '../../../lib/cdata'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      const result = await cdataQuery('JAWS',
        `SELECT DISTINCT [CustomerName] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [CustomerName] IS NOT NULL ORDER BY [CustomerName]`)
      const rows = result?.results?.[0]?.rows || []
      const names: string[] = rows.map((r: any[]) => r[0]).filter(Boolean)
      res.status(200).json({ customers: names, count: names.length })
    } catch (e: any) {
      console.error('myob-customers error:', e)
      res.status(500).json({ error: e.message || 'Failed to load MYOB customers' })
    }
  })
}
