// pages/api/groups/myob-customers.ts
// Returns a distinct list of MYOB customer names seen on JAWS invoices.
// Used by the admin UI to surface "unclassified" customer cards.

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
  } catch {
    return res.status(401).json({ error: 'Unauthenticated' })
  }

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
}
