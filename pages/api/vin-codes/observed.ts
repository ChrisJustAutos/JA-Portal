// pages/api/vin-codes/observed.ts
// Returns distinct VIN prefixes seen on JAWS sales invoices, with occurrence counts.
// The admin UI uses this to show "prefixes that exist in MYOB but aren't mapped yet".

import type { NextApiRequest, NextApiResponse } from 'next'
import { cdataQuery } from '../../../lib/cdata'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cookie = req.cookies['ja_portal_auth']
  const pw = process.env.PORTAL_PASSWORD || 'justautos2026'
  if (!cookie) return res.status(401).json({ error: 'Unauthenticated' })
  try {
    if (Buffer.from(cookie, 'base64').toString('utf8') !== pw) {
      return res.status(401).json({ error: 'Unauthenticated' })
    }
  } catch { return res.status(401).json({ error: 'Unauthenticated' }) }

  try {
    // Pull distinct 4-char prefixes of the CustomerPO field for invoices where
    // the field is long enough to plausibly be a VIN fragment (8+ chars).
    // Also pull a sample full value so the admin can verify it's actually a VIN.
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
}
